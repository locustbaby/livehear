use serde_json::Value;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::PathBuf;

#[derive(Default)]
pub struct TranscriptArchive {
    file: Option<(PathBuf, File)>,
}

impl TranscriptArchive {
    pub fn append(&mut self, items: &[Value]) -> Result<(), String> {
        if items.is_empty() {
            return Ok(());
        }
        let mut bytes = Vec::new();
        for item in items {
            serde_json::to_writer(&mut bytes, item).map_err(|e| e.to_string())?;
            bytes.push(b'\n');
        }
        let file = self.file()?;
        let offset = file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.flush()) {
            file.set_len(offset)
                .map_err(|e| format!("归档写入失败且无法回滚: {e}"))?;
            return Err(error.to_string());
        }
        Ok(())
    }

    pub fn read(&mut self) -> Result<Vec<Value>, String> {
        let Some((_, file)) = self.file.as_mut() else {
            return Ok(Vec::new());
        };
        file.rewind().map_err(|e| e.to_string())?;
        BufReader::new(file)
            .lines()
            .map(|line| {
                let line = line.map_err(|e| e.to_string())?;
                serde_json::from_str(&line).map_err(|e| e.to_string())
            })
            .collect()
    }

    pub fn clear(&mut self) -> Result<(), String> {
        if let Some((_, file)) = self.file.as_mut() {
            file.set_len(0).map_err(|e| e.to_string())?;
            file.rewind().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn file(&mut self) -> Result<&mut File, String> {
        if self.file.is_none() {
            let path = std::env::temp_dir().join(format!(
                "livehear-transcript-{}-{}.jsonl",
                std::process::id(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
            ));
            let mut options = OpenOptions::new();
            options.read(true).write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let file = options.open(&path).map_err(|e| e.to_string())?;
            self.file = Some((path, file));
        }
        Ok(&mut self.file.as_mut().expect("archive file initialized").1)
    }
}

impl Drop for TranscriptArchive {
    fn drop(&mut self) {
        if let Some((path, file)) = self.file.take() {
            drop(file);
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn archive_preserves_order_multiline_text_and_clear_boundaries() {
        let mut archive = TranscriptArchive::default();
        let first = json!({"id":"a", "original":"第一行\n第二行"});
        let second = json!({"id":"b", "translated":"hello"});
        archive.append(std::slice::from_ref(&first)).unwrap();
        assert_eq!(archive.read().unwrap(), vec![first.clone()]);
        archive.append(std::slice::from_ref(&second)).unwrap();
        assert_eq!(archive.read().unwrap(), vec![first, second]);
        archive.clear().unwrap();
        archive.clear().unwrap();
        assert!(archive.read().unwrap().is_empty());
        let third = json!({"id":"c"});
        archive.append(std::slice::from_ref(&third)).unwrap();
        assert_eq!(archive.read().unwrap(), vec![third]);
        let path = archive.file.as_ref().unwrap().0.clone();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(archive);
        assert!(!path.exists());
    }
}
