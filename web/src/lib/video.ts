/**
 * Deterministic frame-by-frame video export: WebCodecs VideoEncoder + mp4-muxer.
 * Every frame is rendered and encoded in turn, so nothing depends on real-time playback.
 * Falls back to MediaRecorder (paced in real time) only when WebCodecs is missing.
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

export interface ExportJob {
  width: number;
  height: number;
  fps: number;
  frames: number;
  bitrate?: number;
  /** Draw frame `f` into ctx (width x height). Resolves once the frame is complete. */
  draw: (f: number, ctx: CanvasRenderingContext2D) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  ext: 'mp4' | 'webm';
  codec: string;
  method: 'webcodecs' | 'mediarecorder';
  frames: number;
}

type MuxCodec = 'avc' | 'hevc' | 'vp9' | 'av1';
const CODECS: [string, MuxCodec][] = [
  ['avc1.640033', 'avc'], ['avc1.640032', 'avc'], ['avc1.640028', 'avc'],
  ['avc1.4d0033', 'avc'], ['avc1.4d0028', 'avc'], ['avc1.42e033', 'avc'],
  ['hvc1.1.6.L153.B0', 'hevc'], ['vp09.00.51.08', 'vp9'], ['av01.0.12M.08', 'av1'],
];

async function pickCodec(width: number, height: number, fps: number, bitrate: number) {
  for (const [codec, mux] of CODECS) {
    const config: VideoEncoderConfig = {
      codec, width, height, bitrate, framerate: fps, latencyMode: 'quality',
      ...(mux === 'avc' ? { avc: { format: 'avc' } } : {}),
      ...(mux === 'hevc' ? { hevc: { format: 'hevc' } } : {}),
    } as VideoEncoderConfig;
    try {
      const s = await VideoEncoder.isConfigSupported(config);
      if (s.supported) return { config: s.config ?? config, mux };
    } catch { /* try the next one */ }
  }
  return null;
}

export const hasWebCodecs = () => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';

export async function exportVideo(job: ExportJob): Promise<ExportResult> {
  const canvas = document.createElement('canvas');
  canvas.width = job.width;
  canvas.height = job.height;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const bitrate = job.bitrate ?? Math.round(job.width * job.height * job.fps * 0.12);
  if (hasWebCodecs()) {
    const picked = await pickCodec(job.width, job.height, job.fps, bitrate);
    if (picked) return encodeWebCodecs(job, canvas, ctx, picked.config, picked.mux);
  }
  return encodeMediaRecorder(job, canvas, ctx);
}

async function encodeWebCodecs(job: ExportJob, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D,
  config: VideoEncoderConfig, mux: MuxCodec): Promise<ExportResult> {
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: mux, width: job.width, height: job.height, frameRate: job.fps },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e instanceof Error ? e : new Error(String(e)); },
  });
  encoder.configure(config);
  const us = 1e6 / job.fps;
  try {
    for (let f = 0; f < job.frames; f++) {
      if (job.signal?.aborted) throw new DOMException('export cancelled', 'AbortError');
      if (failure) throw failure;
      await job.draw(f, ctx);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(f * us), duration: Math.round(us) });
      encoder.encode(frame, { keyFrame: f % (job.fps * 2) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
      job.onProgress?.(f + 1, job.frames);
    }
    await encoder.flush();
    if (failure) throw failure;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  muxer.finalize();
  return { blob: new Blob([target.buffer], { type: 'video/mp4' }), ext: 'mp4', codec: config.codec, method: 'webcodecs', frames: job.frames };
}

async function encodeMediaRecorder(job: ExportJob, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Promise<ExportResult> {
  if (typeof MediaRecorder === 'undefined') throw new Error('neither WebCodecs nor MediaRecorder is available');
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12e6 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>((r) => { rec.onstop = () => r(); });
  rec.start();
  const dt = 1000 / job.fps;
  let next = performance.now();
  try {
    for (let f = 0; f < job.frames; f++) {
      if (job.signal?.aborted) throw new DOMException('export cancelled', 'AbortError');
      await job.draw(f, ctx);
      // MediaRecorder timestamps frames by wall clock, so frames must be paced in real time
      next += dt;
      const wait = next - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      track.requestFrame();
      job.onProgress?.(f + 1, job.frames);
    }
  } finally {
    rec.stop();
    await stopped;
  }
  const type = rec.mimeType || mimeType || 'video/webm';
  return {
    blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm', codec: type,
    method: 'mediarecorder', frames: job.frames,
  };
}
