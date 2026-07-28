import Foundation

/// The process's `phys_footprint`, in bytes — the same number `footprint(1)`
/// reports and the one Apple's own jetsam accounting uses.
///
/// RSS is deliberately not offered here: G2 raised a false alarm on it, because
/// RSS counts clean pages the kernel can reclaim for free and so tracks a file
/// read that is about to be discarded.
func physFootprint() -> Int {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
        }
    }
    return kr == KERN_SUCCESS ? Int(info.phys_footprint) : 0
}
