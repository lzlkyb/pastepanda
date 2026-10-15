//! Peak RSS（Windows：GetProcessMemoryInfo 的 PeakWorkingSetSize，单调水位）。
//! a1/a2 两个探针共用同一实现，口径一致。

#[repr(C)]
struct ProcessMemoryCounters {
    cb: u32,
    page_fault_count: u32,
    peak_working_set_size: usize,
    working_set_size: usize,
    quota_peak_paged_pool_usage: usize,
    quota_paged_pool_usage: usize,
    quota_peak_non_paged_pool_usage: usize,
    quota_non_paged_pool_usage: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
}

extern "system" {
    fn GetCurrentProcess() -> *mut std::ffi::c_void;
    #[link_name = "K32GetProcessMemoryInfo"]
    fn get_process_memory_info(
        process: *mut std::ffi::c_void,
        counters: *mut ProcessMemoryCounters,
        size: u32,
    ) -> i32;
}

pub fn peak_working_set_mb() -> f64 {
    let mut pc = ProcessMemoryCounters {
        cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
        page_fault_count: 0,
        peak_working_set_size: 0,
        working_set_size: 0,
        quota_peak_paged_pool_usage: 0,
        quota_paged_pool_usage: 0,
        quota_peak_non_paged_pool_usage: 0,
        quota_non_paged_pool_usage: 0,
        pagefile_usage: 0,
        peak_pagefile_usage: 0,
    };
    let ok = unsafe {
        get_process_memory_info(
            GetCurrentProcess(),
            &mut pc,
            std::mem::size_of::<ProcessMemoryCounters>() as u32,
        )
    };
    if ok == 0 {
        return 0.0;
    }
    pc.peak_working_set_size as f64 / 1048576.0
}
