//! Local speech-to-text for the composer's dictation button, on a whisper.cpp
//! model file the user picks. The model stays loaded between dictations and
//! is dropped after a quiet spell, since it holds well over a gigabyte.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::ipc::{InvokeBody, Request};
use tauri::State;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const IDLE_UNLOAD: Duration = Duration::from_secs(120);
const SAMPLE_RATE: usize = 16_000;
const MAX_SECONDS: usize = 10 * 60;
/// Below this peak the take is silence; whisper would invent a caption for it.
const SILENCE_PEAK: f32 = 0.005;

struct Loaded {
    path: String,
    ctx: WhisperContext,
    last_used: Instant,
}

#[derive(Clone, Default)]
pub struct DictationHost(Arc<Mutex<Option<Loaded>>>);

#[derive(Debug, PartialEq)]
struct Options {
    model: String,
    language: String,
    prompt: String,
}

/// Options ride in one form-encoded header so the body can stay raw audio.
fn parse_options(header: &str) -> Result<Options, String> {
    let mut options = Options {
        model: String::new(),
        language: "auto".into(),
        prompt: String::new(),
    };
    for (key, value) in url::form_urlencoded::parse(header.as_bytes()) {
        match key.as_ref() {
            "model" => options.model = value.into_owned(),
            "language" if !value.trim().is_empty() => {
                options.language = value.trim().to_lowercase()
            }
            // CString rejects interior NULs.
            "prompt" => options.prompt = value.replace('\0', ""),
            _ => {}
        }
    }
    if options.model.trim().is_empty() {
        return Err("Choose a dictation model in Settings.".into());
    }
    // An unknown code does not fail in whisper.cpp; it silently decodes garbage.
    if options.language != "auto"
        && (options.language.contains('\0') || whisper_rs::get_lang_id(&options.language).is_none())
    {
        return Err(format!("Unknown dictation language: {}", options.language));
    }
    Ok(options)
}

fn decode_samples(bytes: &[u8]) -> Result<Vec<f32>, String> {
    let (frames, rest) = bytes.as_chunks::<4>();
    if frames.is_empty() || !rest.is_empty() {
        return Err("Dictation audio is malformed.".into());
    }
    if frames.len() > SAMPLE_RATE * MAX_SECONDS {
        return Err("Dictation is limited to 10 minutes.".into());
    }
    Ok(frames
        .iter()
        .map(|frame| f32::from_le_bytes(*frame))
        .collect())
}

fn is_silent(samples: &[f32]) -> bool {
    samples.iter().all(|sample| sample.abs() < SILENCE_PEAK)
}

fn load(path: &str) -> Result<WhisperContext, String> {
    if !std::path::Path::new(path).is_file() {
        return Err(format!("Dictation model not found: {path}"));
    }
    whisper_rs::install_logging_hooks();
    WhisperContext::new_with_params(path, WhisperContextParameters::default())
        .map_err(|error| format!("Could not load the dictation model: {error}"))
}

fn transcribe(host: &DictationHost, options: &Options, samples: &[f32]) -> Result<String, String> {
    let mut slot = host.0.lock().unwrap_or_else(|e| e.into_inner());
    if slot
        .as_ref()
        .is_none_or(|loaded| loaded.path != options.model)
    {
        // Drop the old model first so two never sit in memory together.
        *slot = None;
        *slot = Some(Loaded {
            ctx: load(&options.model)?,
            path: options.model.clone(),
            last_used: Instant::now(),
        });
    }
    let loaded = slot.as_mut().expect("model loaded above");

    let mut params = FullParams::new(SamplingStrategy::BeamSearch {
        beam_size: 5,
        patience: -1.0,
    });
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get().min(8));
    params.set_n_threads(threads as i32);
    params.set_language(Some(&options.language));
    if !options.prompt.is_empty() {
        params.set_initial_prompt(&options.prompt);
    }
    params.set_no_context(true);
    params.set_no_timestamps(true);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);

    let mut state = loaded
        .ctx
        .create_state()
        .map_err(|error| format!("Dictation failed: {error}"))?;
    state
        .full(params, samples)
        .map_err(|error| format!("Dictation failed: {error}"))?;
    let text = state
        .as_iter()
        .filter_map(|segment| segment.to_str_lossy().ok().map(|text| text.into_owned()))
        .collect::<String>();
    loaded.last_used = Instant::now();
    Ok(text.trim().to_string())
}

fn schedule_unload(host: DictationHost) {
    std::thread::spawn(move || {
        std::thread::sleep(IDLE_UNLOAD);
        let mut slot = host.0.lock().unwrap_or_else(|e| e.into_inner());
        if slot
            .as_ref()
            .is_some_and(|loaded| loaded.last_used.elapsed() >= IDLE_UNLOAD)
        {
            *slot = None;
        }
    });
}

/// Body: mono 16 kHz f32 little-endian PCM. Header `x-dictation`: form-encoded
/// `model`, `language` and `prompt`.
#[tauri::command]
pub async fn dictation_transcribe(
    host: State<'_, DictationHost>,
    request: Request<'_>,
) -> Result<String, String> {
    let header = request
        .headers()
        .get("x-dictation")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let options = parse_options(header)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Dictation audio is malformed.".into());
    };
    let samples = decode_samples(bytes)?;
    if is_silent(&samples) {
        return Ok(String::new());
    }
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let text = transcribe(&host, &options, &samples);
        schedule_unload(host);
        text
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_decode_percent_encoded_unicode() {
        let options =
            parse_options("model=%2Fm%2Fggml.bin&language=pt&prompt=Tauri+Studio%2C+Jos%C3%A9")
                .unwrap();
        assert_eq!(
            options,
            Options {
                model: "/m/ggml.bin".into(),
                language: "pt".into(),
                prompt: "Tauri Studio, José".into(),
            }
        );
    }

    #[test]
    fn options_require_a_model_and_default_to_auto_language() {
        assert!(parse_options("language=pt").is_err());
        assert_eq!(parse_options("model=m&language=").unwrap().language, "auto");
    }

    #[test]
    fn options_accept_whisper_languages_in_any_case_and_reject_others() {
        assert_eq!(parse_options("model=m&language=PT").unwrap().language, "pt");
        assert_eq!(
            parse_options("model=m&language=Portuguese")
                .unwrap()
                .language,
            "portuguese"
        );
        assert!(parse_options("model=m&language=pt-BR").is_err());
        assert!(parse_options("model=m&language=p%00t").is_err());
    }

    #[test]
    fn samples_reject_partial_frames_and_overlong_takes() {
        assert!(decode_samples(&[0, 0, 0]).is_err());
        assert!(decode_samples(&[]).is_err());
        let too_long = vec![0u8; (SAMPLE_RATE * MAX_SECONDS + 1) * 4];
        assert!(decode_samples(&too_long).is_err());
        assert_eq!(decode_samples(&0.5f32.to_le_bytes()).unwrap(), vec![0.5]);
    }

    #[test]
    fn silence_is_detected_by_peak() {
        assert!(is_silent(&[0.0, 0.004, -0.0049]));
        assert!(!is_silent(&[0.0, -0.038]));
    }
}
