use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tracing_subscriber::EnvFilter;

const LOG_FILE_NAME: &str = "eden-agent.log";

#[derive(Clone)]
struct SafeLogWriter {
    state: Arc<Mutex<RotatingLogState>>,
    mirror_stderr: bool,
}

struct EventWriter {
    state: Arc<Mutex<RotatingLogState>>,
    mirror_stderr: bool,
    buffer: Vec<u8>,
}

struct RotatingLogState {
    directory: PathBuf,
    file: Option<File>,
    bytes_written: u64,
    max_bytes: u64,
    max_files: usize,
}

impl SafeLogWriter {
    fn new(
        directory: &Path,
        max_bytes: u64,
        max_files: usize,
        mirror_stderr: bool,
    ) -> io::Result<Self> {
        fs::create_dir_all(directory)?;
        let mut state = RotatingLogState {
            directory: directory.to_path_buf(),
            file: None,
            bytes_written: 0,
            max_bytes: max_bytes.max(1),
            max_files: max_files.max(1),
        };
        state.open_active()?;
        Ok(Self {
            state: Arc::new(Mutex::new(state)),
            mirror_stderr,
        })
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SafeLogWriter {
    type Writer = EventWriter;

    fn make_writer(&'a self) -> Self::Writer {
        EventWriter {
            state: Arc::clone(&self.state),
            mirror_stderr: self.mirror_stderr,
            buffer: Vec::with_capacity(512),
        }
    }
}

impl Write for EventWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.buffer.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for EventWriter {
    fn drop(&mut self) {
        if self.buffer.is_empty() {
            return;
        }
        let encoded = String::from_utf8_lossy(&self.buffer);
        let safe = redact_log_text(&encoded);
        if self.mirror_stderr {
            let _ = io::stderr().lock().write_all(safe.as_bytes());
        }
        if let Ok(mut state) = self.state.lock() {
            let _ = state.write_record(safe.as_bytes());
        }
    }
}

impl RotatingLogState {
    fn active_path(&self) -> PathBuf {
        self.directory.join(LOG_FILE_NAME)
    }

    fn backup_path(&self, index: usize) -> PathBuf {
        self.directory.join(format!("{LOG_FILE_NAME}.{index}"))
    }

    fn open_active(&mut self) -> io::Result<()> {
        let path = self.active_path();
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        self.bytes_written = file.metadata()?.len();
        self.file = Some(file);
        Ok(())
    }

    fn write_record(&mut self, bytes: &[u8]) -> io::Result<()> {
        let incoming = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if self.bytes_written > 0 && self.bytes_written.saturating_add(incoming) > self.max_bytes {
            self.rotate()?;
        }
        if self.file.is_none() {
            self.open_active()?;
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("active log file is unavailable"))?;
        file.write_all(bytes)?;
        file.flush()?;
        self.bytes_written = self.bytes_written.saturating_add(incoming);
        Ok(())
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file.take();
        let active = self.active_path();
        if self.max_files == 1 {
            remove_if_present(&active)?;
            self.bytes_written = 0;
            return self.open_active();
        }

        let oldest = self.backup_path(self.max_files - 1);
        remove_if_present(&oldest)?;
        for index in (1..self.max_files - 1).rev() {
            let source = self.backup_path(index);
            if source.exists() {
                let destination = self.backup_path(index + 1);
                remove_if_present(&destination)?;
                fs::rename(source, destination)?;
            }
        }
        if active.exists() {
            let first_backup = self.backup_path(1);
            remove_if_present(&first_backup)?;
            fs::rename(active, first_backup)?;
        }
        self.bytes_written = 0;
        self.open_active()
    }
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn redact_log_text(input: &str) -> String {
    let mut output = input.to_owned();
    for marker in [
        "authorization",
        "api_key",
        "apikey",
        "access_token",
        "refresh_token",
        "token",
        "password",
        "secret",
        "credential",
        "cookie",
    ] {
        output = redact_marker(&output, marker);
    }
    output
}

fn redact_marker(input: &str, marker: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut cursor = 0;
    let mut output = String::with_capacity(input.len());
    while let Some(relative) = lower[cursor..].find(marker) {
        let start = cursor + relative;
        output.push_str(&input[cursor..start]);
        output.push_str(&input[start..start + marker.len()]);
        let mut value_start = start + marker.len();
        while let Some(byte) = input.as_bytes().get(value_start) {
            if matches!(*byte, b' ' | b'=' | b':' | b'\'' | b'\"') {
                output.push(char::from(*byte));
                value_start += 1;
            } else {
                break;
            }
        }
        if value_start == start + marker.len() {
            cursor = value_start;
            continue;
        }
        output.push_str("[REDACTED]");
        let mut value_end = value_start;
        if marker == "authorization"
            && input[value_start..]
                .get(..7)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer "))
        {
            value_end += 7;
        }
        while let Some(byte) = input.as_bytes().get(value_end) {
            if matches!(
                *byte,
                b' ' | b',' | b';' | b'\r' | b'\n' | b'\'' | b'\"' | b'}' | b']'
            ) {
                break;
            }
            value_end += 1;
        }
        cursor = value_end;
    }
    output.push_str(&input[cursor..]);
    output
}

pub fn initialize(
    log_directory: &Path,
    max_bytes: u64,
    max_files: usize,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let writer = SafeLogWriter::new(log_directory, max_bytes, max_files, true)?;
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("eden_agent_server=info")),
        )
        .with_ansi(false)
        .with_writer(writer)
        .try_init()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::fmt::MakeWriter;

    fn emit(writer: &SafeLogWriter, value: &str) {
        let mut event = writer.make_writer();
        event.write_all(value.as_bytes()).expect("write event");
    }

    #[test]
    fn rotating_writer_retains_only_the_configured_files() {
        let directory = tempfile::tempdir().expect("tempdir");
        let writer = SafeLogWriter::new(directory.path(), 8, 3, false).expect("writer");
        emit(&writer, "first\n");
        emit(&writer, "second\n");
        emit(&writer, "third\n");
        emit(&writer, "fourth\n");
        assert_eq!(
            fs::read_to_string(directory.path().join(LOG_FILE_NAME)).expect("active"),
            "fourth\n"
        );
        assert_eq!(
            fs::read_to_string(directory.path().join(format!("{LOG_FILE_NAME}.1")))
                .expect("first backup"),
            "third\n"
        );
        assert_eq!(
            fs::read_to_string(directory.path().join(format!("{LOG_FILE_NAME}.2")))
                .expect("second backup"),
            "second\n"
        );
        assert!(!directory.path().join(format!("{LOG_FILE_NAME}.3")).exists());
    }

    #[test]
    fn persisted_log_redacts_common_credentials() {
        let directory = tempfile::tempdir().expect("tempdir");
        let writer = SafeLogWriter::new(directory.path(), 4096, 2, false).expect("writer");
        emit(
            &writer,
            "request Authorization: Bearer header-secret api_key=alpha token: bearer-secret password='hunter2' safe=value\n",
        );
        let content = fs::read_to_string(directory.path().join(LOG_FILE_NAME)).expect("log");
        assert!(!content.contains("alpha"));
        assert!(!content.contains("header-secret"));
        assert!(!content.contains("bearer-secret"));
        assert!(!content.contains("hunter2"));
        assert!(content.contains("safe=value"));
        assert!(content.contains("[REDACTED]"));
    }
}
