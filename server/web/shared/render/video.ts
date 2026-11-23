// video.ts — frames into a film file, in the browser: H.264 in an MP4 where the browser can encode it
// (WebCodecs), VP9 or VP8 in a WebM where it cannot, and where there is no video encoder at all a zip of the
// frames as PNGs.  The containers are written by mp4-muxer and webm-muxer (both MIT, bundled); the encoding is the
// browser's own.
//
// `planFilm` asks the browser what it can do for a size and rate; `FilmWriter` takes the frames in order and
// `finish()` gives the file.  The muxing half (`ContainerWriter`) takes encoded chunks as plain bytes, so a test
// can run it without a browser.
import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from "mp4-muxer";
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from "webm-muxer";
import { zipStore, type ZipEntry } from "./zip";

export type FilmFormat = "mp4" | "webm" | "png-zip";
export interface FilmPlan {
  format: FilmFormat;
  /** the WebCodecs codec string ("avc1.640028"), empty for a zip of PNGs */
  codec: string;
  width: number; height: number; fps: number; bitrate: number;
  extension: string; mime: string;
  /** why it is not an MP4, when it is not */
  note?: string;
}

/** H.264 and VP9 take even sizes only. */
export const evenSize = (v: number): number => Math.max(2, Math.round(v / 2) * 2);

/** The H.264 level a picture needs (macroblocks per frame and per second, from the standard's table A-1). */
export function avcLevel(width: number, height: number, fps: number): number {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16), rate = mbs * fps;
  const table: [number, number, number][] = [[0x1e, 1620, 40500], [0x1f, 3600, 108000], [0x28, 8192, 245760], [0x2a, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600]];
  for (const [level, frame, perSecond] of table) if (mbs <= frame && rate <= perSecond) return level;
  return 0x34;
}
/** The codec strings worth trying for an MP4, best first: High, Main, then Baseline profile at the level the picture needs. */
export function avcCodecs(width: number, height: number, fps: number): string[] {
  const level = avcLevel(width, height, fps).toString(16).padStart(2, "0");
  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.4200${level}`];
}
/** Bits per second for a picture that was rendered to be looked at closely: generous, a film of clean frames compresses well. */
export const filmBitrate = (width: number, height: number, fps: number): number => Math.round(Math.max(1.5e6, Math.min(8e7, width * height * fps * 0.16)));

/** What this browser can write for a film of this size and rate.  `allow` narrows the choice (a test asks for the fallbacks). */
export async function planFilm(width: number, height: number, fps: number, allow: readonly FilmFormat[] = ["mp4", "webm", "png-zip"]): Promise<FilmPlan> {
  const w = evenSize(width), h = evenSize(height), bitrate = filmBitrate(w, h, fps);
  const base = { width: w, height: h, fps, bitrate };
  const Encoder = (globalThis as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
  const supported = async (codec: string): Promise<boolean> => {
    if (!Encoder || typeof Encoder.isConfigSupported !== "function") return false;
    try { return !!(await Encoder.isConfigSupported({ codec, width: w, height: h, bitrate, framerate: fps })).supported; } catch { return false; }
  };
  let note = Encoder ? "" : "This browser has no video encoder";
  if (allow.includes("mp4")) {
    for (const codec of avcCodecs(w, h, fps)) if (await supported(codec)) return { ...base, format: "mp4", codec, extension: "mp4", mime: "video/mp4" };
    if (Encoder) note = "This browser cannot encode H.264";
  }
  if (allow.includes("webm")) {
    for (const codec of ["vp09.00.40.08", "vp09.00.10.08", "vp8"]) if (await supported(codec)) return { ...base, format: "webm", codec, extension: "webm", mime: "video/webm", ...(note ? { note: `${note}: the film is a WebM` } : {}) };
  }
  return { ...base, format: "png-zip", codec: "", extension: "zip", mime: "application/zip", ...(note ? { note: `${note}: the frames are saved as PNG files in a zip` } : {}) };
}

/** An MP4 or WebM being written from encoded chunks. */
export class ContainerWriter {
  private readonly mp4: Mp4Muxer<Mp4Target> | null = null;
  private readonly webm: WebmMuxer<WebmTarget> | null = null;
  chunks = 0;
  constructor(readonly plan: Pick<FilmPlan, "format" | "codec" | "width" | "height" | "fps">) {
    if (plan.format === "mp4") this.mp4 = new Mp4Muxer({ target: new Mp4Target(), video: { codec: "avc", width: plan.width, height: plan.height, frameRate: plan.fps }, fastStart: "in-memory" });
    else if (plan.format === "webm") this.webm = new WebmMuxer({ target: new WebmTarget(), video: { codec: plan.codec.startsWith("vp8") ? "V_VP8" : "V_VP9", width: plan.width, height: plan.height, frameRate: plan.fps } });
    else throw new Error("A zip of frames has no container.");
  }
  /** One encoded frame as the encoder gave it. */
  add(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    if (this.mp4) this.mp4.addVideoChunk(chunk, meta); else this.webm!.addVideoChunk(chunk, meta);
    this.chunks++;
  }
  /** One encoded frame as bytes: times in microseconds.  The first of a file carries the decoder's configuration (`description`, H.264's avcC). */
  addRaw(data: Uint8Array, type: "key" | "delta", timestamp: number, duration: number, description?: Uint8Array): void {
    const meta = description ? { decoderConfig: { codec: this.plan.codec, codedWidth: this.plan.width, codedHeight: this.plan.height, description } } : undefined;
    if (this.mp4) this.mp4.addVideoChunkRaw(data, type, timestamp, duration, meta); else this.webm!.addVideoChunkRaw(data, type, timestamp, meta);
    this.chunks++;
  }
  finish(): Uint8Array {
    if (this.mp4) { this.mp4.finalize(); return new Uint8Array(this.mp4.target.buffer); }
    this.webm!.finalize(); return new Uint8Array(this.webm!.target.buffer);
  }
}

/** A film being written from pictures. */
export class FilmWriter {
  private readonly container: ContainerWriter | null = null;
  private readonly encoder: VideoEncoder | null = null;
  private readonly stills: ZipEntry[] = [];
  private failure: Error | null = null;
  private count = 0;

  constructor(readonly plan: FilmPlan) {
    if (plan.format === "png-zip") return;
    this.container = new ContainerWriter(plan);
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => { try { this.container!.add(chunk, meta); } catch (e) { this.failure = e instanceof Error ? e : new Error(String(e)); } },
      error: (e) => { this.failure = e; },
    });
    this.encoder.configure({ codec: plan.codec, width: plan.width, height: plan.height, bitrate: plan.bitrate, framerate: plan.fps, latencyMode: "quality", ...(plan.format === "mp4" ? { avc: { format: "avc" as const } } : {}) });
  }

  /** The next frame: a canvas holding the finished picture at the film's size. */
  async add(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void> {
    if (this.failure) throw this.failure;
    const index = this.count++;
    if (!this.encoder) {
      const blob = "convertToBlob" in canvas ? await canvas.convertToBlob({ type: "image/png" }) : await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
      if (!blob) throw new Error("The frame could not be saved as a PNG.");
      this.stills.push({ name: `frame-${String(index + 1).padStart(4, "0")}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
      return;
    }
    const micros = Math.round(1e6 / this.plan.fps);
    const frame = new VideoFrame(canvas, { timestamp: index * micros, duration: micros });
    try { this.encoder.encode(frame, { keyFrame: index % Math.max(1, Math.round(this.plan.fps * 2)) === 0 }); } finally { frame.close(); }
    // do not let frames pile up in the encoder: a 4K frame is 33 MB before it is encoded
    while (this.encoder.encodeQueueSize > 2 && !this.failure) await new Promise((r) => setTimeout(r, 4));
  }

  get frames(): number { return this.count; }

  async finish(): Promise<Blob> {
    if (this.encoder) {
      await this.encoder.flush();
      this.encoder.close();
      if (this.failure) throw this.failure;
      return new Blob([this.container!.finish() as BlobPart], { type: this.plan.mime });
    }
    return new Blob([zipStore(this.stills) as BlobPart], { type: this.plan.mime });
  }
  /** Give up: nothing is kept. */
  cancel(): void { try { if (this.encoder && this.encoder.state !== "closed") this.encoder.close(); } catch { /* already closed */ } this.stills.length = 0; }
}
