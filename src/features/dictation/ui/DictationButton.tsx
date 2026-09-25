import { useEffect, useRef, useState } from "react";
import { IS_MAC } from "../../../platform/tauri/platform";
import { LoaderCircle, Mic } from "../../../shared/ui/icons";
import {
  DICTATION_MAX_SECONDS,
  loadDictationSettings,
  subscribeDictationSettings,
  transcribeDictation,
} from "../model/dictation";
import {
  startDictationRecording,
  type DictationRecording,
} from "../model/recorder";

type Phase = "idle" | "starting" | "recording" | "transcribing";

function errorText(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Microphone access is off. Allow MonoCode in System Settings › Privacy & Security › Microphone.";
  }
  return error instanceof Error ? error.message : String(error);
}

type Props = {
  disabled?: boolean;
  onText: (text: string) => void;
};

/** Records while on, then hands the transcript to `onText`. */
export function DictationButton(props: Props) {
  const [hasModel, setHasModel] = useState(
    () => loadDictationSettings().model != null,
  );
  useEffect(
    () =>
      subscribeDictationSettings(() =>
        setHasModel(loadDictationSettings().model != null),
      ),
    [],
  );
  // Unmounting the control is what releases a live microphone.
  return IS_MAC && hasModel ? <DictationControl {...props} /> : null;
}

function DictationControl({ disabled, onText }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const recording = useRef<DictationRecording | null>(null);
  const mounted = useRef(true);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recording.current?.cancel();
      recording.current = null;
    };
  }, []);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = window.setTimeout(
      () => void finish(),
      DICTATION_MAX_SECONDS * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [phase]);

  const start = async () => {
    setError(null);
    setPhase("starting");
    try {
      const take = await startDictationRecording();
      if (!mounted.current) {
        take.cancel();
        return;
      }
      recording.current = take;
      setPhase("recording");
    } catch (err) {
      setError(errorText(err));
      setPhase("idle");
    }
  };

  const finish = async () => {
    const take = recording.current;
    recording.current = null;
    if (!take) return;
    setPhase("transcribing");
    try {
      const samples = await take.stop();
      if (samples.length === 0) return;
      const text = await transcribeDictation(samples, loadDictationSettings());
      if (text) onTextRef.current(text);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPhase("idle");
    }
  };

  const label =
    phase === "recording"
      ? "Stop dictation"
      : phase === "transcribing"
        ? "Transcribing…"
        : (error ?? "Dictate");

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={phase === "recording"}
      disabled={disabled || phase === "starting" || phase === "transcribing"}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void (phase === "recording" ? finish() : start())}
      className={`grid size-6.5 shrink-0 place-items-center rounded-md ${
        phase === "recording"
          ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
          : error
            ? "bg-selection text-red-400 hover:bg-selection-hover"
            : "bg-selection text-content/50 hover:bg-selection-hover hover:text-content"
      } disabled:opacity-60`}
    >
      {phase === "transcribing" || phase === "starting" ? (
        <LoaderCircle className="size-3.5 animate-spin" />
      ) : (
        <Mic
          className={`size-3.5 ${phase === "recording" ? "animate-pulse" : ""}`}
        />
      )}
    </button>
  );
}
