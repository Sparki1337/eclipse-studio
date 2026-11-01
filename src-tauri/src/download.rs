//! Проверяемые диапазоны HTTP и докачка только при неизменном валидаторе сервера.
use crate::{durable, safe_path};
use reqwest::{blocking::Client, header};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
const BUFFER: usize = 512 * 1024;
const CHECKPOINT: u64 = 8 * 1024 * 1024;
#[derive(Default)]
pub struct Control {
    pub cancelled: AtomicBool,
    pub paused: AtomicBool,
    pub resumable: AtomicBool,
}
impl Control {
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Relaxed) {
            Err("Загрузка отменена".into())
        } else if self.paused.load(Ordering::Relaxed) {
            Err("Загрузка приостановлена; проверенные сегменты сохранены для докачки".into())
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Validator {
    header: String,
    value: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Part {
    start: u64,
    end: u64,
    saved: u64,
    sha256: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    version: u32,
    id: String,
    url: String,
    suggested_name: String,
    file_name: String,
    total: u64,
    validator: Validator,
    parts: Vec<Part>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Downloaded {
    pub path: String,
    pub file_name: String,
    pub sha256: String,
    pub download_id: String,
}
pub fn work_name(url: &str, name: &str) -> String {
    format!(
        ".eclipse-download-{:x}",
        Sha256::digest(format!("{url}\0{name}"))
    )
}
fn save(work: &Path, metadata: &Metadata) -> Result<(), String> {
    durable::write(
        &safe_path::join(work, "metadata.json")?,
        &serde_json::to_vec(metadata).map_err(|e| e.to_string())?,
    )
}
pub fn verify_range(value: &str, start: u64, end: u64, total: u64) -> Result<(), String> {
    if value != format!("bytes {start}-{end}/{total}") {
        return Err(format!(
            "Content-Range не совпадает: ожидалось bytes {start}-{end}/{total}"
        ));
    }
    Ok(())
}
fn validator(response: &reqwest::blocking::Response) -> Option<Validator> {
    if let Some(value) = response
        .headers()
        .get(header::ETAG)
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.starts_with("W/"))
    {
        return Some(Validator {
            header: "etag".into(),
            value: value.into(),
        });
    }
    response
        .headers()
        .get(header::LAST_MODIFIED)
        .and_then(|v| v.to_str().ok())
        .map(|value| Validator {
            header: "last-modified".into(),
            value: value.into(),
        })
}
fn identity_encoding(response: &reqwest::blocking::Response) -> Result<(), String> {
    if response
        .headers()
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v != "identity")
    {
        return Err("Сервер сжал тело диапазона вопреки Accept-Encoding: identity".into());
    }
    Ok(())
}
fn partition(total: u64) -> Vec<Part> {
    let count = if total >= 4 * 1024 * 1024 {
        6.min((total / (2 * 1024 * 1024)).max(2))
    } else {
        1
    };
    (0..count)
        .map(|i| Part {
            start: total * i / count,
            end: total * (i + 1) / count - 1,
            saved: 0,
            sha256: String::new(),
        })
        .collect()
}
fn available(directory: &Path, name: &str) -> PathBuf {
    let original = directory.join(name);
    if !original.exists() {
        return original;
    }
    let path = Path::new(name);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    directory.join(format!("{stem}-{}{ext}", uuid::Uuid::new_v4()))
}
pub fn fetch(
    url: &str,
    name: &str,
    directory: &Path,
    expected_hash: Option<&str>,
    control: &Arc<Control>,
    progress: impl Fn(u64, Option<u64>, bool) + Sync,
) -> Result<Downloaded, String> {
    if !url.starts_with("https://") {
        return Err("Разрешены только HTTPS-ссылки".into());
    }
    safe_path::validate_component(name)?;
    if let Some(hash) = expected_hash {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Некорректная ожидаемая SHA-256".into());
        }
    }
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let directory = safe_path::root(directory)?;
    let work = safe_path::join(&directory, &work_name(url, name))?;
    // files_download держит блокировку work на всё время задания, включая сборку.

    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let client = Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(900))
        .no_gzip()
        .no_brotli()
        .pool_max_idle_per_host(6)
        .build()
        .map_err(|e| e.to_string())?;
    let head = client
        .head(url)
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .ok();
    let total = head
        .as_ref()
        .and_then(|r| r.content_length())
        .filter(|n| *n > 0);
    let validators = head.as_ref().and_then(validator);
    let ranges = head
        .as_ref()
        .and_then(|r| r.headers().get(header::ACCEPT_RANGES))
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("bytes"));
    let result = if let (Some(total), Some(validator), true) = (total, validators, ranges) {
        if total > 100 * 1024 * 1024 * 1024 {
            return Err("Файл превышает лимит загрузки 100 ГБ".into());
        }
        control.resumable.store(true, Ordering::Relaxed);
        ranged(
            &client,
            url,
            name,
            &directory,
            &work,
            total,
            validator,
            expected_hash,
            control,
            &progress,
        )
    } else {
        control.resumable.store(false, Ordering::Relaxed);
        sequential(
            &client,
            url,
            name,
            &directory,
            total,
            expected_hash,
            control,
            &progress,
        )
    };
    if result.is_ok() || control.cancelled.load(Ordering::Relaxed) {
        let _ = fs::remove_dir_all(&work);
    }
    result
}
fn checkpoint(
    work: &Path,
    metadata: &Mutex<Metadata>,
    index: usize,
    path: &Path,
    file: &fs::File,
    length: u64,
) -> Result<(), String> {
    file.sync_all().map_err(|e| e.to_string())?;
    let hash = durable::hash_file(path)?;
    let mut metadata = metadata.lock().map_err(|_| "Ошибка метаданных загрузки")?;
    metadata.parts[index].saved = length;
    metadata.parts[index].sha256 = hash;
    save(work, &metadata)
}
#[allow(clippy::too_many_arguments)]
fn ranged(
    client: &Client,
    url: &str,
    name: &str,
    directory: &Path,
    work: &Path,
    total: u64,
    validator: Validator,
    expected_hash: Option<&str>,
    control: &Arc<Control>,
    progress: &(impl Fn(u64, Option<u64>, bool) + Sync),
) -> Result<Downloaded, String> {
    let mut metadata = Metadata {
        version: 1,
        id: uuid::Uuid::new_v4().to_string(),
        url: url.into(),
        suggested_name: name.into(),
        file_name: available(directory, name)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        total,
        validator,
        parts: partition(total),
    };
    let path = safe_path::join(work, "metadata.json")?;
    if path.exists() {
        let data = fs::read(&path).map_err(|e| e.to_string())?;
        if data.len() > 64 * 1024 {
            return Err("Метаданные загрузки слишком велики".into());
        }
        let previous: Metadata = serde_json::from_slice(&data)
            .map_err(|_| "Метаданные докачки повреждены; удалите приостановленную загрузку")?;
        if previous.version == 1
            && previous.url == metadata.url
            && previous.suggested_name == metadata.suggested_name
            && previous.total == total
            && previous.validator == metadata.validator
            && previous.parts.len() == metadata.parts.len()
            && previous.parts.iter().zip(&metadata.parts).all(|(a, b)| {
                a.start == b.start && a.end == b.end && a.saved <= a.end - a.start + 1
            })
        {
            safe_path::validate_component(&previous.file_name)?;
            metadata = previous;
        }
    }
    // После аварийного завершения используем только подтверждённый и повторно хешированный префикс.
    for (index, part) in metadata.parts.iter_mut().enumerate() {
        let path = safe_path::join(work, &format!("segment-{index}"))?;
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        if file.metadata().map_err(|e| e.to_string())?.len() < part.saved {
            part.saved = 0;
            part.sha256 = String::new();
        }
        file.set_len(part.saved).map_err(|e| e.to_string())?;
        if part.saved > 0 && durable::hash_file(&path)? != part.sha256 {
            file.set_len(0).map_err(|e| e.to_string())?;
            part.saved = 0;
            part.sha256 = String::new();
        }
    }
    save(work, &metadata)?;
    let downloaded = AtomicU64::new(metadata.parts.iter().map(|p| p.saved).sum());
    let abort = AtomicBool::new(false);
    progress(downloaded.load(Ordering::Relaxed), Some(total), true);
    let count = metadata.parts.len();
    let metadata = Mutex::new(metadata);
    let results = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for index in 0..count {
            let downloaded = &downloaded;
            let abort = &abort;
            let metadata = &metadata;
            handles.push(scope.spawn(move||{
                let part=metadata.lock().map_err(|_|"Ошибка метаданных")?.parts[index].clone();
                let length=part.end-part.start+1;if part.saved==length{return Ok(());}
                let path=safe_path::join(work,&format!("segment-{index}"))?;
                let mut file=fs::OpenOptions::new().append(true).open(&path).map_err(|e|e.to_string())?;
                let mut saved=part.saved;let validator=metadata.lock().map_err(|_|"Ошибка метаданных")?.validator.clone();
                let result=(||->Result<(),String>{
                    control.check()?;
                    let start=part.start+saved;
                    let mut response=client.get(url).header(header::ACCEPT_ENCODING,"identity").header(header::RANGE,format!("bytes={start}-{}",part.end)).header(header::IF_RANGE,&validator.value).send().map_err(|e|format!("Ошибка диапазона: {e}"))?;
                    if response.status()!=reqwest::StatusCode::PARTIAL_CONTENT{return Err("Сервер не подтвердил диапазон HTTP 206. Непроверенные части не используются.".into());}
                    identity_encoding(&response)?;
                    verify_range(response.headers().get(header::CONTENT_RANGE).and_then(|v|v.to_str().ok()).ok_or("Нет Content-Range")?,start,part.end,total)?;
                    if response.headers().get(&validator.header).and_then(|v|v.to_str().ok())!=Some(validator.value.as_str()){return Err("ETag/Last-Modified изменился между сегментами".into());}
                    if response.content_length().is_some_and(|n|n!=length-saved){return Err("Размер HTTP-диапазона не совпадает".into());}
                    let mut buffer=vec![0;BUFFER];let mut last_saved=saved;
                    loop{
                        control.check()?;if abort.load(Ordering::Relaxed){return Err("Загрузка остановлена из-за ошибки другого сегмента".into());}
                        let read=response.read(&mut buffer).map_err(|e|e.to_string())?;if read==0{break;}
                        if saved+read as u64>length{return Err("Сервер прислал лишние байты сегмента".into());}
                        file.write_all(&buffer[..read]).map_err(|e|e.to_string())?;saved+=read as u64;
                        let current=downloaded.fetch_add(read as u64,Ordering::Relaxed)+read as u64;progress(current,Some(total),true);
                        if saved-last_saved>=CHECKPOINT{checkpoint(work,metadata,index,&path,&file,saved)?;last_saved=saved;}
                    }
                    if saved!=length{return Err("Сегмент оборван раньше объявленного размера".into());}Ok(())
                })();
                let checkpoint_result=checkpoint(work,metadata,index,&path,&file,saved);
                if result.is_err()||checkpoint_result.is_err(){abort.store(true,Ordering::Relaxed);}
                result.and(checkpoint_result)
            }));
        }
        handles
            .into_iter()
            .map(|h| {
                h.join()
                    .map_err(|_| "Поток загрузки завершился аварийно".to_string())?
            })
            .collect::<Result<Vec<_>, String>>()
    });
    if let Err(error) = results {
        control.check()?;
        return Err(error);
    }
    control.check()?;
    let metadata = metadata.into_inner().map_err(|_| "Ошибка метаданных")?;
    let mut output = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    let mut assembled = 0;
    for (index, part) in metadata.parts.iter().enumerate() {
        control.check()?;
        let path = safe_path::join(work, &format!("segment-{index}"))?;
        if part.saved != part.end - part.start + 1 || durable::hash_file(&path)? != part.sha256 {
            return Err("Сохранённый сегмент повреждён".into());
        }
        assembled += std::io::copy(
            &mut fs::File::open(path).map_err(|e| e.to_string())?,
            &mut output,
        )
        .map_err(|e| e.to_string())?;
    }
    if assembled != total {
        return Err("Итоговый размер файла не совпадает".into());
    }
    output.as_file().sync_all().map_err(|e| e.to_string())?;
    let sha256 = durable::hash_file(output.path())?;
    if expected_hash.is_some_and(|h| !h.eq_ignore_ascii_case(&sha256)) {
        return Err("Контрольная сумма SHA-256 загрузки не совпадает".into());
    }
    let target = safe_path::join(directory, &metadata.file_name)?;
    output
        .persist_noclobber(&target)
        .map_err(|e| format!("Не удалось сохранить файл без перезаписи существующего: {e}"))?;
    progress(total, Some(total), true);
    Ok(Downloaded {
        path: target.display().to_string(),
        file_name: metadata.file_name,
        sha256,
        download_id: metadata.id,
    })
}
#[allow(clippy::too_many_arguments)]
fn sequential(
    client: &Client,
    url: &str,
    name: &str,
    directory: &Path,
    total: Option<u64>,
    expected_hash: Option<&str>,
    control: &Control,
    progress: &(impl Fn(u64, Option<u64>, bool) + Sync),
) -> Result<Downloaded, String> {
    let mut response = client
        .get(url)
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|e| e.to_string())?;
    identity_encoding(&response)?;
    let expected = total.or(response.content_length());
    if total.is_some() && response.content_length().is_some() && total != response.content_length()
    {
        return Err("Размер файла изменился между HEAD и GET".into());
    }
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    let mut downloaded = 0;
    let mut buffer = vec![0; BUFFER];
    progress(0, expected, false);
    loop {
        control.check()?;
        let read = response.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        downloaded += read as u64;
        if downloaded > 100 * 1024 * 1024 * 1024 || expected.is_some_and(|e| downloaded > e) {
            return Err("Ответ превышает объявленный или разрешённый размер".into());
        }
        file.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
        progress(downloaded, expected, false);
    }
    if expected.is_some_and(|n| n != downloaded) {
        return Err("Загрузка оборвана: размер файла не совпадает".into());
    }
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    let sha256 = durable::hash_file(file.path())?;
    if expected_hash.is_some_and(|h| !h.eq_ignore_ascii_case(&sha256)) {
        return Err("SHA-256 не совпадает".into());
    }
    let target = available(directory, name);
    file.persist_noclobber(&target).map_err(|e| e.to_string())?;
    Ok(Downloaded {
        path: target.display().to_string(),
        file_name: target
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        sha256,
        download_id: uuid::Uuid::new_v4().to_string(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_must_match_including_total() {
        assert!(verify_range("bytes 10-19/100", 10, 19, 100).is_ok());
        for v in [
            "bytes 0-19/100",
            "bytes 10-18/100",
            "bytes 10-19/101",
            "bytes 10-19/*",
            "garbage",
        ] {
            assert!(verify_range(v, 10, 19, 100).is_err());
        }
    }
    #[test]
    fn partition_has_no_gaps_or_overlaps() {
        for total in [1, 10, 4 * 1024 * 1024, 17 * 1024 * 1024 + 1] {
            let p = partition(total);
            assert_eq!(p[0].start, 0);
            assert_eq!(p.last().unwrap().end, total - 1);
            for pair in p.windows(2) {
                assert_eq!(pair[0].end + 1, pair[1].start);
            }
            assert_eq!(p.iter().map(|p| p.end - p.start + 1).sum::<u64>(), total);
        }
    }
    #[test]
    fn pause_is_not_cancel() {
        let c = Control::default();
        c.paused.store(true, Ordering::Relaxed);
        assert!(c.check().unwrap_err().contains("приостановлена"));
        assert!(!c.cancelled.load(Ordering::Relaxed));
    }
    fn server(body: Vec<u8>, mode: &'static str) -> (String, std::thread::JoinHandle<()>) {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/file.zip", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let count = if mode == "interrupt" { 2 } else { 1 };
            for index in 0..count {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut byte = [0u8; 1];
                while !request.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                let request = String::from_utf8(request).unwrap().to_lowercase();
                let start = request
                    .lines()
                    .find_map(|line| line.strip_prefix("range: bytes="))
                    .unwrap()
                    .split('-')
                    .next()
                    .unwrap()
                    .parse::<usize>()
                    .unwrap();
                assert!(request.contains("if-range: \"version-1\""));
                if mode == "bad-range" {
                    write!(stream,"HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes 0-{}/{}\r\nETag: \"version-1\"\r\nConnection: close\r\n\r\n",body.len(),body.len()-1,body.len()+1).unwrap();
                    let _ = stream.write_all(&body);
                    continue;
                }
                write!(stream,"HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nETag: \"version-1\"\r\nConnection: close\r\n\r\n",body.len()-start,start,body.len()-1,body.len()).unwrap();
                let end = if mode == "interrupt" && index == 0 {
                    10
                } else {
                    body.len()
                };
                let _ = stream.write_all(&body[start..end]);
            }
        });
        (url, thread)
    }
    fn range_args() -> (tempfile::TempDir, PathBuf, Arc<Control>, Client, Validator) {
        let temp = tempfile::tempdir().unwrap();
        let work = temp.path().join("parts");
        fs::create_dir(&work).unwrap();
        (
            temp,
            work,
            Arc::new(Control::default()),
            Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            Validator {
                header: "etag".into(),
                value: "\"version-1\"".into(),
            },
        )
    }
    #[test]
    fn interrupted_download_resumes_from_verified_prefix() {
        let body = (0u8..64).collect::<Vec<_>>();
        let (url, server) = server(body.clone(), "interrupt");
        let (temp, work, control, client, validator) = range_args();
        assert!(ranged(
            &client,
            &url,
            "file.zip",
            temp.path(),
            &work,
            64,
            validator.clone(),
            None,
            &control,
            &|_, _, _| {}
        )
        .is_err());
        let meta: Metadata =
            serde_json::from_slice(&fs::read(work.join("metadata.json")).unwrap()).unwrap();
        assert_eq!(meta.parts[0].saved, 10);
        let result = ranged(
            &client,
            &url,
            "file.zip",
            temp.path(),
            &work,
            64,
            validator,
            None,
            &control,
            &|_, _, _| {},
        )
        .unwrap();
        assert_eq!(fs::read(result.path).unwrap(), body);
        server.join().unwrap();
    }
    #[test]
    fn pause_keeps_segments_and_resume_does_not_redownload_complete_part() {
        let body = vec![42u8; 64];
        let (url, server) = server(body.clone(), "valid");
        let (temp, work, control, client, validator) = range_args();
        let first = ranged(
            &client,
            &url,
            "file.zip",
            temp.path(),
            &work,
            64,
            validator.clone(),
            None,
            &control,
            &|n, _, _| {
                if n > 0 {
                    control.paused.store(true, Ordering::Relaxed);
                }
            },
        );
        assert!(first.unwrap_err().contains("приостановлена"));
        server.join().unwrap();
        let resumed = ranged(
            &client,
            &url,
            "file.zip",
            temp.path(),
            &work,
            64,
            validator,
            None,
            &Arc::new(Control::default()),
            &|_, _, _| {},
        )
        .unwrap();
        assert_eq!(fs::read(resumed.path).unwrap(), body);
    }
    #[test]
    fn wrong_range_never_publishes_download() {
        let (url, server) = server(vec![42u8; 64], "bad-range");
        let (temp, work, control, client, validator) = range_args();
        assert!(ranged(
            &client,
            &url,
            "file.zip",
            temp.path(),
            &work,
            64,
            validator,
            None,
            &control,
            &|_, _, _| {}
        )
        .is_err());
        assert!(!temp.path().join("file.zip").exists());
        assert_eq!(fs::metadata(work.join("segment-0")).unwrap().len(), 0);
        server.join().unwrap();
    }
    #[test]
    fn corrupted_prefix_is_truncated_and_revalidated() {
        let body = vec![17u8; 64];
        let (url, server) = server(body.clone(), "valid");
        let (temp, work, control, client, validator) = range_args();
        let metadata = Metadata {
            version: 1,
            id: "existing-job".into(),
            url: url.clone(),
            suggested_name: "file.zip".into(),
            file_name: "file.zip".into(),
            total: 64,
            validator: validator.clone(),
            parts: vec![Part {
                start: 0,
                end: 63,
                saved: 10,
                sha256: format!("{:x}", Sha256::digest(&body[..10])),
            }],
        };
        save(&work, &metadata).unwrap();
        fs::write(work.join("segment-0"), [99u8; 13]).unwrap();
        let result = ranged(
            &client,
            &url,
            "file.zip",
            temp.path(),
            &work,
            64,
            validator,
            None,
            &control,
            &|_, _, _| {},
        )
        .unwrap();
        assert_eq!(result.download_id, "existing-job");
        assert_eq!(fs::read(result.path).unwrap(), body);
        server.join().unwrap();
    }
}
