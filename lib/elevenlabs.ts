const API_BASE = "https://api.elevenlabs.io";

function apiKey(): string {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new Error("ELEVENLABS_API_KEY must be set");
  return k;
}

export type CreatePodcastInput = {
  text: string;
  modelId: string;
  hostVoiceId: string;
  guestVoiceId: string;
};

export type CreatePodcastResponse = {
  projectId: string;
};

export async function createConversationalPodcast(
  input: CreatePodcastInput
): Promise<CreatePodcastResponse> {
  const body = {
    model_id: input.modelId,
    mode: {
      type: "conversation",
      conversation: {
        host_voice_id: input.hostVoiceId,
        guest_voice_id: input.guestVoiceId,
      },
    },
    source: { type: "text", text: input.text },
    duration_scale: "long",
    quality_preset: "high",
  };

  const res = await fetch(`${API_BASE}/v1/studio/podcasts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey(),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`ElevenLabs createPodcast ${res.status}: ${txt}`);
  }

  const json = await res.json();
  const projectId = json?.project?.project_id;
  if (!projectId) {
    throw new Error(`ElevenLabs createPodcast: no project_id in response`);
  }
  return { projectId };
}

export type ProjectStatus =
  | "pending"
  | "creating"
  | "in_queue"
  | "converting"
  | "finished"
  | "failed";

export type ProjectStatusResponse = {
  status: ProjectStatus;
  progress: number;
  raw: unknown;
};

export async function getProjectStatus(
  projectId: string
): Promise<ProjectStatusResponse> {
  const res = await fetch(`${API_BASE}/v1/studio/projects/${projectId}`, {
    headers: { "xi-api-key": apiKey() },
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`ElevenLabs getProjectStatus ${res.status}: ${txt}`);
  }

  const json = await res.json();
  const status: ProjectStatus =
    json?.creation_meta?.status ?? json?.state ?? "pending";
  const progress = Number(json?.creation_meta?.creation_progress ?? 0);
  return { status, progress, raw: json };
}

// TODO: confirm the exact audio download endpoint during build.
// Likely candidates: /v1/studio/projects/{id}/audio or a per-chapter download.
export async function downloadProjectAudio(
  projectId: string
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const res = await fetch(
    `${API_BASE}/v1/studio/projects/${projectId}/audio`,
    { headers: { "xi-api-key": apiKey() } }
  );

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`ElevenLabs downloadAudio ${res.status}: ${txt}`);
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") ?? "audio/mpeg";
  return { bytes: buf, contentType };
}
