/**
 * The alert sound, synthesised rather than shipped as an audio file.
 *
 * Two reasons: no binary asset to load (a counter PC on club wifi should not
 * wait on a download before it can alert), and the tone can be tuned in code.
 * Two soft notes, deliberately not an alarm — this fires all day in a pro shop
 * and an aggressive sound gets muted within a week, which is the failure mode
 * that silently kills the whole feature.
 */
let ctx: AudioContext | null = null;

export function primeAudio() {
  // Browsers refuse to play audio until a user gesture. Called on first click
  // so the chime works later without one.
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx.state;
}

export function playChime(volume = 0.35) {
  if (!ctx) primeAudio();
  if (!ctx || ctx.state !== "running") return false;

  const now = ctx.currentTime;
  // A rising fifth: recognisable, calm, cuts through room noise without alarm.
  [
    { f: 660, t: 0 },
    { f: 990, t: 0.13 },
  ].forEach(({ f, t }) => {
    const osc = ctx!.createOscillator();
    const gain = ctx!.createGain();
    osc.type = "sine";
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0, now + t);
    gain.gain.linearRampToValueAtTime(volume, now + t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.45);
    osc.connect(gain).connect(ctx!.destination);
    osc.start(now + t);
    osc.stop(now + t + 0.5);
  });
  return true;
}

export function audioReady() {
  return ctx?.state === "running";
}
