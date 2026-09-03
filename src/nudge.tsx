import {
  Action,
  ActionPanel,
  Color,
  confirmAlert,
  Form,
  Icon,
  Keyboard,
  List,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState } from "react";
import { listSubtitleFiles, nudgeApply, nudgeUndo, nudgeUnpin, SubtitleFile, SUBSYNC_URL } from "./subtitles-api";

const QUICK_MS = [-1000, -500, -250, -100, 100, 250, 500, 1000];

function fmtMs(ms: number): string {
  return `${ms > 0 ? "+" : ""}${ms} ms`;
}

function CustomNudge(props: { file: SubtitleFile; onDone: (ms: number) => Promise<void> }) {
  const { pop } = useNavigation();
  const [value, setValue] = useState("");
  return (
    <Form
      navigationTitle={`Nudge ${props.file.name}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Apply Nudge"
            onSubmit={async () => {
              const ms = Number(value);
              if (!ms) {
                await showToast({ style: Toast.Style.Failure, title: "Enter a non-zero number of milliseconds" });
                return;
              }
              await props.onDone(ms);
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description title="File" text={props.file.rel} />
      <Form.TextField id="ms" title="Shift (ms)" placeholder="-250" value={value} onChange={setValue} info="Negative = subtitles appear earlier, positive = later" />
      <Form.Description text={`Net nudge so far: ${fmtMs(props.file.nudgedMs)}${props.file.pinned ? " · pinned" : ""}`} />
    </Form>
  );
}

export default function Nudge() {
  const { data, isLoading, revalidate, mutate } = useCachedPromise(listSubtitleFiles, [], { keepPreviousData: true });

  // update the row locally; the server patches its own cache, so no slow refetch is needed
  function patchLocal(path: string, change: { pinned?: boolean; deltaMs?: number }) {
    return (files: SubtitleFile[] | undefined) =>
      (files ?? []).map((f) =>
        f.path === path
          ? { ...f, pinned: change.pinned ?? f.pinned, nudgedMs: f.nudgedMs + (change.deltaMs ?? 0) }
          : f,
      );
  }

  async function apply(f: SubtitleFile, ms: number) {
    const toast = await showToast({ style: Toast.Style.Animated, title: `Nudging ${fmtMs(ms)}…` });
    try {
      const r = await mutate(nudgeApply(f.path, ms), {
        optimisticUpdate: patchLocal(f.path, { pinned: true, deltaMs: ms }),
        shouldRevalidateAfter: false,
      });
      toast.style = Toast.Style.Success;
      toast.title = `Shifted ${fmtMs(r.ms)} · ${r.cues} cues · pinned`;
      toast.message = `net ${fmtMs(f.nudgedMs + r.ms)} — restart playback in Jellyfin to pick it up`;
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Nudge failed";
      toast.message = String(e instanceof Error ? e.message : e);
    }
  }

  async function undo(f: SubtitleFile) {
    try {
      const r = await mutate(nudgeUndo(f.path), { shouldRevalidateAfter: false });
      await mutate(Promise.resolve(), {
        optimisticUpdate: patchLocal(f.path, { deltaMs: r.restored_ms }),
        shouldRevalidateAfter: false,
      });
      await showToast({ style: Toast.Style.Success, title: `Undid last nudge (${fmtMs(r.restored_ms)})` });
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Undo failed", message: String(e instanceof Error ? e.message : e) });
    }
  }

  async function unpin(f: SubtitleFile) {
    if (!(await confirmAlert({ title: `Unpin ${f.name}?`, message: "The nightly sync will manage this file again and may re-time it." }))) return;
    try {
      await mutate(nudgeUnpin(f.path), {
        optimisticUpdate: patchLocal(f.path, { pinned: false }),
        shouldRevalidateAfter: false,
      });
      await showToast({ style: Toast.Style.Success, title: "Unpinned — nightly sync will manage it again" });
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Unpin failed", message: String(e instanceof Error ? e.message : e) });
    }
  }

  const files = data ?? [];
  const pinned = files.filter((f) => f.pinned);
  const rest = files.filter((f) => !f.pinned);

  function row(f: SubtitleFile) {
    const folder = f.rel.split("/").slice(0, -1).join("/");
    return (
      <List.Item
        key={f.path}
        icon={{ source: f.pinned ? Icon.Pin : Icon.Text, tintColor: f.pinned ? Color.Orange : Color.SecondaryText }}
        title={f.name}
        subtitle={folder}
        keywords={folder.split(/[/ ]+/)}
        accessories={[
          ...(f.nudgedMs !== 0 ? [{ tag: { value: fmtMs(f.nudgedMs), color: Color.Blue }, tooltip: "net manual nudge" }] : []),
          ...(f.pinned ? [{ tag: { value: "pinned", color: Color.Orange }, tooltip: "excluded from nightly sync" }] : []),
          { tag: f.lang.toUpperCase() },
        ]}
        actions={
          <ActionPanel>
            <ActionPanel.Section title="Nudge">
              <Action title="Earlier 100 Ms (−100)" icon={Icon.ArrowLeft} shortcut={{ modifiers: ["cmd"], key: "-" }} onAction={() => apply(f, -100)} />
              <Action title="Later 100 Ms (+100)" icon={Icon.ArrowRight} shortcut={{ modifiers: ["cmd"], key: "=" }} onAction={() => apply(f, 100)} />
              <Action title="Earlier 500 Ms (−500)" icon={Icon.ArrowLeft} shortcut={{ modifiers: ["cmd", "shift"], key: "-" }} onAction={() => apply(f, -500)} />
              <Action title="Later 500 Ms (+500)" icon={Icon.ArrowRight} shortcut={{ modifiers: ["cmd", "shift"], key: "=" }} onAction={() => apply(f, 500)} />
              <ActionPanel.Submenu title="Quick Nudge…" icon={Icon.Clock} shortcut={Keyboard.Shortcut.Common.New}>
                {QUICK_MS.map((ms) => (
                  <Action key={ms} title={fmtMs(ms)} icon={ms < 0 ? Icon.ArrowLeft : Icon.ArrowRight} onAction={() => apply(f, ms)} />
                ))}
              </ActionPanel.Submenu>
              <Action.Push
                title="Custom Nudge…"
                icon={Icon.Pencil}
                shortcut={Keyboard.Shortcut.Common.Edit}
                target={<CustomNudge file={f} onDone={(ms) => apply(f, ms)} />}
              />
            </ActionPanel.Section>
            <ActionPanel.Section>
              <Action title="Undo Last Nudge" icon={Icon.Undo} shortcut={{ modifiers: ["cmd"], key: "z" }} onAction={() => undo(f)} />
              {f.pinned && <Action title="Unpin (Let Nightly Sync Manage)" icon={Icon.PinDisabled} style={Action.Style.Destructive} onAction={() => unpin(f)} />}
              <Action.OpenInBrowser title="Open Nudge Page" url={`${SUBSYNC_URL}/nudge`} shortcut={Keyboard.Shortcut.Common.Open} />
              <Action title="Refresh" icon={Icon.ArrowClockwise} shortcut={Keyboard.Shortcut.Common.Refresh} onAction={revalidate} />
            </ActionPanel.Section>
          </ActionPanel>
        }
      />
    );
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder={`Filter ${files.length} subtitle files… e.g. walking dead s05e01 sr`}>
      {pinned.length > 0 && <List.Section title={`Pinned (${pinned.length})`}>{pinned.map(row)}</List.Section>}
      <List.Section title={`Library (${rest.length})`}>{rest.map(row)}</List.Section>
    </List>
  );
}
