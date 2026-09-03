import { Action, ActionPanel, Clipboard, closeMainWindow, Form, getPreferenceValues, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";

interface Preferences {
  metubeUrl?: string;
}

const METUBE_URL = "https://metube.bjelke.org";

// destinations mirror the MeTube mounts: default dir feeds the ABS YouTube
// library, .ambients/.work feed Navidrome, .xxx is a video dir.
// Everything defaults to opus audio; .xxx can opt into video via Quality.
const FOLDERS: { value: string; title: string; videoOption?: boolean }[] = [
  { value: "", title: "ABS YouTube library" },
  { value: ".ambients", title: "Music — .ambients" },
  { value: ".work", title: "Music — .work" },
  { value: ".xxx", title: ".xxx", videoOption: true },
];

export default function Metube() {
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState("");
  const [quality, setQuality] = useState("opus");

  useEffect(() => {
    Clipboard.readText().then((t) => {
      if (t && /^https?:\/\//.test(t.trim())) setUrl(t.trim());
    });
  }, []);

  async function submit() {
    const p = getPreferenceValues<Preferences>();
    const base = !p.metubeUrl || p.metubeUrl.includes(".ts.net") ? METUBE_URL : p.metubeUrl.replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url.trim())) {
      await showToast({ style: Toast.Style.Failure, title: "Not a URL", message: "Paste a video link first" });
      return;
    }
    const wantsVideo = FOLDERS.find((f) => f.value === folder)?.videoOption && quality !== "opus";
    const toast = await showToast({ style: Toast.Style.Animated, title: "Sending to MeTube…" });
    try {
      const res = await fetch(`${base}/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          url: url.trim(),
          // MeTube only accepts quality "best" for the opus format
          quality: wantsVideo ? quality : "best",
          format: wantsVideo ? "any" : "opus",
          folder,
          auto_start: true,
        }),
      });
      // errors come back as plain text ("400: …"), success as JSON
      const raw = await res.text();
      if (!res.ok) throw new Error(raw.slice(0, 120));
      const body = JSON.parse(raw) as { status?: string; msg?: string };
      if (body.status === "error") throw new Error(body.msg ?? "unknown error");
      toast.style = Toast.Style.Success;
      toast.title = "Queued in MeTube";
      toast.message = `${wantsVideo ? `video ${quality}` : "audio (opus)"} → ${folder || "ABS YouTube"}`;
      await closeMainWindow();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "MeTube rejected it";
      toast.message = String(e instanceof Error ? e.message : e);
    }
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Send to Metube" onSubmit={submit} />
          <Action.OpenInBrowser title="Open Metube" url={METUBE_URL} />
        </ActionPanel>
      }
    >
      <Form.TextField id="url" title="URL" placeholder="https://youtube.com/watch?v=…" value={url} onChange={setUrl} />
      <Form.Dropdown id="folder" title="Destination" value={folder} onChange={setFolder}>
        {FOLDERS.map((f) => (
          <Form.Dropdown.Item key={f.value || "default"} value={f.value} title={f.title} />
        ))}
      </Form.Dropdown>
      {FOLDERS.find((f) => f.value === folder)?.videoOption && (
        <Form.Dropdown id="quality" title="Quality" value={quality} onChange={setQuality}>
          <Form.Dropdown.Item value="opus" title="Audio (opus)" />
          <Form.Dropdown.Item value="best" title="Video — Best" />
          <Form.Dropdown.Item value="1080" title="Video — 1080p" />
          <Form.Dropdown.Item value="720" title="Video — 720p" />
        </Form.Dropdown>
      )}
      <Form.Description text="Everything downloads as opus audio by default: the default feeds the ABS YouTube library, the Music ones feed Navidrome's dropboxes. Pick a video quality on .xxx to get video instead." />
    </Form>
  );
}
