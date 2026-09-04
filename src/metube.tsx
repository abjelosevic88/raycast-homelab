import {
  Action,
  ActionPanel,
  Clipboard,
  closeMainWindow,
  Form,
  showToast,
  Toast,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { optionalUrl, requireUrl, setting } from "./config";

const METUBE_URL = optionalUrl("metubeUrl");

interface Folder {
  value: string;
  title: string;
  video?: boolean;
}

// Destinations come from the `metubeFolders` preference: "folder|Label[|video],…".
// The default download dir is always offered first and downloads opus audio;
// entries flagged |video download video instead.
function folders(): Folder[] {
  const extra = setting("metubeFolders")
    .split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const [value, title, flag] = raw.split("|").map((x) => x.trim());
      return {
        value,
        title: title || value,
        video: flag?.toLowerCase() === "video",
      };
    });
  return [{ value: "", title: "Default folder (audio)" }, ...extra];
}

export default function Metube() {
  const FOLDERS = folders();
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState("");
  const [quality, setQuality] = useState("best");

  useEffect(() => {
    Clipboard.readText().then((t) => {
      if (t && /^https?:\/\//.test(t.trim())) setUrl(t.trim());
    });
  }, []);

  async function submit() {
    const base = requireUrl("metubeUrl", "MeTube");
    if (!/^https?:\/\//.test(url.trim())) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Not a URL",
        message: "Paste a video link first",
      });
      return;
    }
    const wantsVideo = Boolean(FOLDERS.find((f) => f.value === folder)?.video);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Sending to MeTube…",
    });
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
      toast.message = `${wantsVideo ? `video ${quality}` : "audio (opus)"} → ${folder || "default folder"}`;
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
      <Form.TextField
        id="url"
        title="URL"
        placeholder="https://youtube.com/watch?v=…"
        value={url}
        onChange={setUrl}
      />
      <Form.Dropdown
        id="folder"
        title="Destination"
        value={folder}
        onChange={setFolder}
      >
        {FOLDERS.map((f) => (
          <Form.Dropdown.Item
            key={f.value || "default"}
            value={f.value}
            title={f.title}
          />
        ))}
      </Form.Dropdown>
      {FOLDERS.find((f) => f.value === folder)?.video && (
        <Form.Dropdown
          id="quality"
          title="Quality"
          value={quality}
          onChange={setQuality}
        >
          <Form.Dropdown.Item value="best" title="Best" />
          <Form.Dropdown.Item value="1080" title="1080p" />
          <Form.Dropdown.Item value="720" title="720p" />
        </Form.Dropdown>
      )}
      <Form.Description text="Audio destinations download opus audio. Add more folders (and video ones) in the MeTube Destinations preference." />
    </Form>
  );
}
