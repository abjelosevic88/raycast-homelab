import { Action, ActionPanel, Clipboard, closeMainWindow, Form, getPreferenceValues, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";

interface Preferences {
  metubeUrl?: string;
}

const METUBE_URL = "https://metube.bjelke.org";

// destinations mirror the MeTube mounts: default dir feeds the ABS YouTube
// library (audio), .ambients/.work feed Navidrome, .xxx is a video dir
const FOLDERS: { value: string; title: string; kind: "audio" | "video" }[] = [
  { value: "", title: "ABS YouTube library (audio)", kind: "audio" },
  { value: ".ambients", title: "Music — .ambients", kind: "audio" },
  { value: ".work", title: "Music — .work", kind: "audio" },
  { value: ".xxx", title: ".xxx (video)", kind: "video" },
];

export default function Metube() {
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState("");
  const [quality, setQuality] = useState("best");

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
    const kind = FOLDERS.find((f) => f.value === folder)?.kind ?? "audio";
    const toast = await showToast({ style: Toast.Style.Animated, title: "Sending to MeTube…" });
    try {
      const res = await fetch(`${base}/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          url: url.trim(),
          quality: kind === "audio" ? "audio" : quality,
          format: kind === "audio" ? "opus" : "any",
          folder,
          auto_start: true,
        }),
      });
      const body = (await res.json()) as { status?: string; msg?: string };
      if (!res.ok || body.status === "error") throw new Error(body.msg ?? `HTTP ${res.status}`);
      toast.style = Toast.Style.Success;
      toast.title = "Queued in MeTube";
      toast.message = `${kind} → ${folder || "ABS YouTube"}`;
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
      {FOLDERS.find((f) => f.value === folder)?.kind === "video" && (
        <Form.Dropdown id="quality" title="Quality" value={quality} onChange={setQuality}>
          <Form.Dropdown.Item value="best" title="Best" />
          <Form.Dropdown.Item value="1080" title="1080p" />
          <Form.Dropdown.Item value="720" title="720p" />
        </Form.Dropdown>
      )}
      <Form.Description text="Audio destinations download opus: default feeds the ABS YouTube library, the Music ones feed Navidrome's dropboxes." />
    </Form>
  );
}
