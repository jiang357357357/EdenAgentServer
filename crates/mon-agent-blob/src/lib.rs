//! Content-addressed binary storage kept outside the JSON-RPC transport.

use mon_agent_domain::BlobId;
use mon_agent_store::{BlobRecord, Store, StoreError};
use sha2::{Digest, Sha256};
use std::{
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use thiserror::Error;
use tokio::{fs, io::AsyncWriteExt};
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum BlobError {
    #[error("blob is too large: {actual} bytes exceeds {maximum} byte limit")]
    TooLarge { actual: usize, maximum: usize },
    #[error("blob metadata points outside the blob store")]
    InvalidStoragePath,
    #[error("blob content failed its integrity check")]
    IntegrityMismatch,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Store(#[from] StoreError),
}

#[derive(Clone)]
pub struct BlobService {
    root: Arc<PathBuf>,
    store: Store,
    max_bytes: usize,
}

impl BlobService {
    pub async fn new(
        root: impl Into<PathBuf>,
        store: Store,
        max_bytes: usize,
    ) -> Result<Self, BlobError> {
        let root = root.into();
        fs::create_dir_all(&root).await?;
        Ok(Self {
            root: Arc::new(root),
            store,
            max_bytes,
        })
    }

    #[must_use]
    pub fn max_bytes(&self) -> usize {
        self.max_bytes
    }

    pub async fn put(
        &self,
        mime: impl Into<String>,
        bytes: &[u8],
    ) -> Result<BlobRecord, BlobError> {
        if bytes.len() > self.max_bytes {
            return Err(BlobError::TooLarge {
                actual: bytes.len(),
                maximum: self.max_bytes,
            });
        }
        let sha256 = hex::encode(Sha256::digest(bytes));
        let relative = PathBuf::from(&sha256[..2]).join(&sha256);
        let target = self.root.join(&relative);
        if fs::metadata(&target).await.is_err() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).await?;
            }
            let temporary = target.with_extension(format!("tmp-{}", Uuid::new_v4()));
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .await?;
            file.write_all(bytes).await?;
            file.sync_all().await?;
            drop(file);
            match fs::rename(&temporary, &target).await {
                Ok(()) => {}
                Err(_) if fs::metadata(&target).await.is_ok() => {
                    let _ = fs::remove_file(&temporary).await;
                }
                Err(error) => {
                    let _ = fs::remove_file(&temporary).await;
                    return Err(error.into());
                }
            }
        }
        self.store
            .put_blob_metadata(
                sha256,
                mime,
                i64::try_from(bytes.len()).unwrap_or(i64::MAX),
                relative.to_string_lossy(),
            )
            .await
            .map_err(Into::into)
    }

    pub async fn read(&self, id: BlobId) -> Result<(BlobRecord, Vec<u8>), BlobError> {
        let record = self.store.get_blob(id).await?;
        let relative = Path::new(&record.storage_path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(BlobError::InvalidStoragePath);
        }
        let bytes = fs::read(self.root.join(relative)).await?;
        if hex::encode(Sha256::digest(&bytes)) != record.sha256 {
            return Err(BlobError::IntegrityMismatch);
        }
        Ok((record, bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn blobs_are_content_addressed_and_deduplicated() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = Store::in_memory().await.expect("store");
        let blobs = BlobService::new(directory.path(), store, 1024)
            .await
            .expect("blobs");
        let first = blobs.put("text/plain", b"hello").await.expect("first");
        let second = blobs.put("text/plain", b"hello").await.expect("second");
        assert_eq!(first.id, second.id);
        let (record, bytes) = blobs.read(first.id).await.expect("read");
        assert_eq!(record.sha256, first.sha256);
        assert_eq!(bytes, b"hello");
    }

    #[tokio::test]
    async fn rejects_oversized_content_before_writing() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = Store::in_memory().await.expect("store");
        let blobs = BlobService::new(directory.path(), store, 4)
            .await
            .expect("blobs");
        assert!(matches!(
            blobs.put("text/plain", b"hello").await,
            Err(BlobError::TooLarge { .. })
        ));
    }
}
