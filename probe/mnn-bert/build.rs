fn main() {
    // MNN prebuilt（与 vendor/ocr-rs/build.rs 同一下载源：
    // github.com/zibo-chen/MNN-Prebuilds/releases/download/dev/mnn-dev-windows-x86_64.zip）
    let include = std::env::var("MNN_PROBE_INCLUDE").expect(
        "MNN_PROBE_INCLUDE 未设：指向解压后的 mnn-dev-windows-x86_64/include",
    );
    let lib = std::env::var("MNN_PROBE_LIB").expect(
        "MNN_PROBE_LIB 未设：指向解压后的 mnn-dev-windows-x86_64/lib（含 MNN_static.lib）",
    );

    cc::Build::new()
        .cpp(true)
        .file("cpp/mnn_bert_probe.cpp")
        .include(&include)
        .define("MNN_BUILD_API", None)
        // 源文件是 UTF-8（含中文注释），cl 默认按 CP936 解析会吞掉后续声明
        // （C4819 → C2062「意外的类型 __int64」）。显式声明源码/执行字符集。
        .flag("/utf-8")
        .compile("mnn_bert_probe");

    println!("cargo:rustc-link-search=native={}", lib);
    // 必须走动态链接：MNN_static.lib 是 /MT 编译的（RuntimeLibrary=MT_StaticRelease），
    // 与 Rust msvc target 的 /MD 冲突（LNK2038，已实测）。主工程 vendored ocr-rs
    // 同样因此用 MNN.lib（DLL import lib）+ 运行时侧载 MNN.dll。
    // 跑之前把 MNN.dll 拷到 exe 同目录（README「运行」节）。
    println!("cargo:rustc-link-lib=dylib=MNN");
}
