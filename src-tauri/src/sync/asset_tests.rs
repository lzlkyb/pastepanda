use super::*;
use crate::sync::{engine, identity::NodeIdentity, session};
use iroh::endpoint::{presets, RelayMode};

struct Fixture {
    root: PathBuf,
    a: DataStore,
    b: DataStore,
    a_images: PathBuf,
    b_images: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("kb-asset-probe-{}", uuid::Uuid::new_v4()));
        let a_dir = root.join("desktop");
        let b_dir = root.join("phone");
        let a_images = a_dir.join("images");
        let b_images = b_dir.join("images");
        std::fs::create_dir_all(&a_images).unwrap();
        std::fs::create_dir_all(&b_images).unwrap();
        let a = DataStore::new(&a_dir.join("pp.db").to_string_lossy()).unwrap();
        let b = DataStore::new(&b_dir.join("pp.db").to_string_lossy()).unwrap();
        for store in [&a, &b] {
            let mut config = store.get_config().unwrap();
            config[crate::sync::presence::ENABLE_KEY] = serde_json::json!(true);
            store.save_config(&config).unwrap();
        }
        Self {
            root,
            a,
            b,
            a_images,
            b_images,
        }
    }
    fn seed(&self) -> (String, attach::AssetRef, Vec<u8>) {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(3, 3)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let bytes = bytes.into_inner();
        let asset = attach::AssetRef {
            hash: format!("{:x}", Md5::digest(&bytes)),
            ext: "png".into(),
        };
        std::fs::write(self.a_images.join(asset.file_name()), &bytes).unwrap();
        let note = self
            .a
            .note_create(
                None,
                "单张补齐测试",
                &format!("![image](pp-asset:{})", asset.file_name()),
            )
            .unwrap();
        (note.id, asset, bytes)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
async fn endpoint(root: &Path, asset_capable: bool) -> Endpoint {
    std::fs::create_dir_all(root).unwrap();
    let me = NodeIdentity::load_or_create(root).unwrap();
    let mut protocols = vec![transport::ALPN.to_vec()];
    if asset_capable {
        protocols.push(ALPN.to_vec());
    }
    Endpoint::builder(presets::Minimal)
        .secret_key(me.iroh_secret())
        .relay_mode(RelayMode::Disabled)
        .clear_address_lookup()
        .alpns(protocols)
        .bind()
        .await
        .unwrap()
}
fn address(endpoint: &Endpoint) -> EndpointAddr {
    let mut address = EndpointAddr::new(endpoint.id());
    for socket in endpoint.bound_sockets() {
        let ip = match socket.ip() {
            std::net::IpAddr::V4(ip) if ip.is_unspecified() => {
                std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
            }
            std::net::IpAddr::V6(ip) if ip.is_unspecified() => {
                std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
            }
            ip => ip,
        };
        address = address.with_ip_addr(std::net::SocketAddr::new(ip, socket.port()));
    }
    address
}

#[test]
fn asset_access_requires_enabled_knowledge_peer_and_live_note_reference() {
    let fixture = Fixture::new();
    let (id, asset, bytes) = fixture.seed();
    assert_eq!(
        authorized(&fixture.a, "rc-only-peer").unwrap_err().code,
        "unauthorized"
    );
    fixture.a.device_pair("knowledge-peer", "电脑", "").unwrap();
    assert!(authorized(&fixture.a, "knowledge-peer").is_ok());
    fixture.a.device_set_paused("knowledge-peer", true).unwrap();
    assert_eq!(
        authorized(&fixture.a, "knowledge-peer").unwrap_err().code,
        "paused"
    );
    fixture
        .a
        .device_set_paused("knowledge-peer", false)
        .unwrap();
    let mut config = fixture.a.get_config().unwrap();
    config[crate::sync::presence::ENABLE_KEY] = serde_json::json!(false);
    fixture.a.save_config(&config).unwrap();
    assert_eq!(
        authorized(&fixture.a, "knowledge-peer").unwrap_err().code,
        "sync_disabled"
    );
    assert!(reference(&fixture.a, &id, &format!("pp-asset:{}", asset.file_name())).is_ok());
    assert_eq!(
        reference(&fixture.a, &id, "pp-asset:../../private.png")
            .unwrap_err()
            .code,
        "invalid"
    );
    let other = fixture.a.note_create(None, "无图片", "正文").unwrap();
    assert_eq!(
        reference(
            &fixture.a,
            &other.id,
            &format!("pp-asset:{}", asset.file_name())
        )
        .unwrap_err()
        .code,
        "missing"
    );
    assert_eq!(
        validate(&asset, b"forged bytes").unwrap_err().code,
        "integrity"
    );
    adopt(&fixture.b_images, &asset, &bytes).unwrap();
    assert_eq!(
        std::fs::read(fixture.b_images.join(asset.file_name())).unwrap(),
        bytes
    );
}

#[tokio::test]
async fn actual_two_endpoints_first_sync_single_missing_image_and_reverse_edit_converge() {
    let fixture = Fixture::new();
    let (id, asset, bytes) = fixture.seed();
    let relative = format!("images/{}", asset.file_name());
    fixture.a.note_update(&id, "相对路径图片", &format!("![图片]({relative})")).unwrap();
    let ep_a = endpoint(&fixture.root.join("a-identity"), true).await;
    let ep_b = endpoint(&fixture.root.join("b-identity"), true).await;
    let a = ep_a.id().to_string();
    let b = ep_b.id().to_string();
    fixture.a.device_pair(&b, "手机", "").unwrap();
    fixture.b.device_pair(&a, "电脑", "").unwrap();
    let paired = |peer: &str| peer == a;
    let (sent, received) = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::join!(
            session::dial_session(&fixture.a, &ep_a, &b, address(&ep_b), false),
            session::accept_session(&fixture.b, &ep_b, &paired)
        )
    })
    .await
    .unwrap();
    assert_eq!(sent.unwrap().assets_skipped, 0);
    assert_eq!(received.unwrap().applied.created, 1);
    assert_eq!(
        std::fs::read(fixture.b_images.join(asset.file_name())).unwrap(),
        bytes
    );
    let cursor = fixture.b.device_cursor(&a);
    std::fs::remove_file(fixture.b_images.join(asset.file_name())).unwrap();
    let request_asset = reference(&fixture.b, &id, &relative).unwrap();
    assert_eq!(request_asset, asset);
    let (download, served) = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::join!(fetch(&ep_b, address(&ep_a), &a, &id, &request_asset), async {
            let wire = transport::accept(&ep_a).await.unwrap();
            serve(&fixture.a, wire, &b).await
        })
    })
    .await
    .unwrap();
    served.unwrap();
    adopt(&fixture.b_images, &asset, &download.unwrap()).unwrap();
    assert_eq!(
        fixture.b.device_cursor(&a),
        cursor,
        "single-image fetch must never advance note cursors"
    );
    assert_eq!(
        std::fs::read(fixture.b_images.join(asset.file_name())).unwrap(),
        bytes
    );
    let local = fixture.b.note_get(&id).unwrap().unwrap();
    fixture
        .b
        .note_update(&id, &local.title, &format!("{}\n手机补充", local.content))
        .unwrap();
    let known = |peer: &str| peer == b;
    let (phone, desktop) = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::join!(
            session::dial_session(&fixture.b, &ep_b, &a, address(&ep_a), false),
            session::accept_session(&fixture.a, &ep_a, &known)
        )
    })
    .await
    .unwrap();
    assert_eq!(phone.unwrap().applied.conflicts, 0);
    assert_eq!(desktop.unwrap().applied.updated, 1);
    assert!(fixture
        .a
        .note_get(&id)
        .unwrap()
        .unwrap()
        .content
        .contains("手机补充"));
    assert_eq!(
        engine::compute_delta(&fixture.a, fixture.a.device_cursor(&b))
            .unwrap()
            .notes
            .len(),
        0
    );
    ep_a.close().await;
    ep_b.close().await;
}

#[tokio::test]
async fn cancelled_download_keeps_no_partial_image_and_retry_completes() {
    let fixture = Fixture::new();
    let (id, asset, bytes) = fixture.seed();
    let ep_a = endpoint(&fixture.root.join("a-identity"), true).await;
    let ep_b = endpoint(&fixture.root.join("b-identity"), true).await;
    let a = ep_a.id().to_string();
    let b = ep_b.id().to_string();
    fixture.a.device_pair(&b, "手机", "").unwrap();
    let mut downloading = Box::pin(fetch(&ep_b, address(&ep_a), &a, &id, &asset));
    let mut opening = Box::pin(transport::accept(&ep_a));
    let mut wire = tokio::select! {
        wire = &mut opening => wire.unwrap(),
        result = &mut downloading => panic!("must be awaiting response: {result:?}"),
    };
    // Read the request and send a valid header, then withhold the image body.
    let mut received = Box::pin(transport::read_frame(&mut wire.recv));
    tokio::select! {
        request = &mut received => { request.unwrap(); },
        result = &mut downloading => panic!("must be awaiting header: {result:?}"),
    }
    drop(received);
    let header = serde_json::to_vec(&Response::Ok {
        bytes: bytes.len() as u64,
    })
    .unwrap();
    transport::write_frame(&mut wire.send, &header)
        .await
        .unwrap();
    assert!(futures_util::poll!(downloading.as_mut()).is_pending());
    drop(downloading);
    tokio::time::timeout(Duration::from_secs(3), wire.conn.closed())
        .await
        .unwrap();
    assert!(!fixture.b_images.join(asset.file_name()).exists());
    assert_eq!(std::fs::read_dir(&fixture.b_images).unwrap().count(), 0);
    let (result, served) = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::join!(fetch(&ep_b, address(&ep_a), &a, &id, &asset), async {
            let wire = transport::accept(&ep_a).await.unwrap();
            serve(&fixture.a, wire, &b).await
        })
    })
    .await
    .unwrap();
    served.unwrap();
    adopt(&fixture.b_images, &asset, &result.unwrap()).unwrap();
    assert_eq!(
        std::fs::read(fixture.b_images.join(asset.file_name())).unwrap(),
        bytes
    );
    ep_a.close().await;
    ep_b.close().await;
}

#[tokio::test]
async fn old_endpoint_returns_unsupported_without_a_sync_frame_or_hanging() {
    let fixture = Fixture::new();
    let (id, asset, _) = fixture.seed();
    let old = endpoint(&fixture.root.join("old"), false).await;
    let modern = endpoint(&fixture.root.join("modern"), true).await;
    let peer = old.id().to_string();
    let error = tokio::time::timeout(Duration::from_secs(5), async {
        let (result, rejected) = tokio::join!(
            fetch(&modern, address(&old), &peer, &id, &asset),
            async { old.accept().await.unwrap().await }
        );
        assert!(rejected.is_err(), "old listener must reject unknown ALPN");
        result.unwrap_err()
    }).await.unwrap();
    assert_eq!(error.code, "unsupported");
    old.close().await;
    modern.close().await;
}

#[tokio::test]
async fn local_asset_symlink_escape_is_rejected_and_corrupt_copy_can_be_repaired() {
    let fixture = Fixture::new();
    let (_, asset, bytes) = fixture.seed();
    let destination = fixture.b_images.join(asset.file_name());
    std::fs::write(&destination, "truncated copy").unwrap();
    assert_eq!(
        read_local(&fixture.b_images, &asset)
            .await
            .unwrap_err()
            .code,
        "integrity"
    );
    adopt(&fixture.b_images, &asset, &bytes).unwrap();
    assert_eq!(read_local(&fixture.b_images, &asset).await.unwrap(), bytes);
    let private = fixture.root.join(asset.file_name());
    std::fs::write(&private, &bytes).unwrap();
    std::fs::remove_file(&destination).unwrap();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(&private, &destination);
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&private, &destination);
    if linked.is_ok() {
        assert_eq!(
            read_local(&fixture.b_images, &asset)
                .await
                .unwrap_err()
                .code,
            "invalid"
        );
        adopt(&fixture.b_images, &asset, &bytes).unwrap();
        assert_eq!(read_local(&fixture.b_images, &asset).await.unwrap(), bytes);
        assert_eq!(std::fs::read(private).unwrap(), bytes);
    }
}
