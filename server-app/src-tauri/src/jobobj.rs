//! Ties the server child process to this app's lifetime on Windows.
//!
//! One process-wide Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is created lazily. Every server child is assigned
//! to it. The job handle is never closed, so the kernel closes it when this process dies (crash, task manager, logout),
//! and that kills the server. Closing the window does not matter here: the process stays alive in the tray.
//! All failures are non-fatal; the function reports them as `false` and the app keeps working without the job.

/// Assigns `child` to the kill-on-close job. Returns true when the child is in the job.
#[cfg(windows)]
pub fn assign_to_kill_on_close_job(child: &std::process::Child) -> bool {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

    // the handle is stored as an integer (0 = no job) so the static is Send + Sync; it is intentionally never closed
    static JOB: OnceLock<isize> = OnceLock::new();
    let job = *JOB.get_or_init(create_kill_on_close_job);
    if job == 0 {
        return false;
    }
    // SAFETY: `job` is a live job handle created above and never closed; the process handle is valid while `child` lives
    unsafe { AssignProcessToJobObject(job as _, child.as_raw_handle() as _) != 0 }
}

/// Creates the job with KILL_ON_JOB_CLOSE. Returns the handle as an integer, or 0 on any failure.
#[cfg(windows)]
fn create_kill_on_close_job() -> isize {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // SAFETY: plain Win32 calls with valid, correctly sized structures; on failure the handle is closed again
    unsafe {
        let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if h as isize == 0 {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            h,
            JobObjectExtendedLimitInformation,
            &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            CloseHandle(h);
            return 0;
        }
        h as isize
    }
}

#[cfg(not(windows))]
pub fn assign_to_kill_on_close_job(_child: &std::process::Child) -> bool {
    false
}
