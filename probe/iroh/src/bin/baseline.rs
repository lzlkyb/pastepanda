//! 体积基线：与探针**同一个工程、同一套 release 参数**，唯一区别是不引用 iroh。
//! 链接期会把没被引用的 crate 剥掉，两个 exe 的差值即 iroh 的净贡献。
#[tokio::main]
async fn main() {
    // 用一下 tokio 与 anyhow，免得它们也被剥掉——基线要含它们，
    // 因为 pastePanda 本来就有这两样。
    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    let r: anyhow::Result<()> = Ok(());
    println!("baseline {:?}", r.is_ok());
}
