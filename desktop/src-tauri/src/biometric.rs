//! Native user verification for the Code lock: Windows Hello on Windows, Touch ID on macOS.
//!
//! The remote web UI reaches these through the signal bridge in lib.rs (no Tauri IPC). Both functions
//! block until the OS answers, so callers run them on a worker thread.

use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
pub struct BioStatus {
    pub available: bool,
    /// hello | touchid | none
    pub kind: &'static str,
    /// Why verification is unavailable (absent when available).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct BioResult {
    pub ok: bool,
    /// cancelled | unavailable | failed | unsupported; null when ok.
    pub error: Option<&'static str>,
}

impl BioStatus {
    fn unavailable(reason: &'static str) -> Self {
        Self {
            available: false,
            kind: "none",
            reason: Some(reason),
        }
    }
}

impl BioResult {
    #[cfg(any(windows, target_os = "macos"))]
    fn ok() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    fn err(code: &'static str) -> Self {
        Self {
            ok: false,
            error: Some(code),
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::{BioResult, BioStatus};
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult as Verdict, UserConsentVerifier,
        UserConsentVerifierAvailability as Avail,
    };
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    /// Worker threads have no WinRT apartment yet; WinRT calls need one.
    fn init_thread() {
        // SAFETY: plain apartment init for this thread; RPC_E_CHANGED_MODE (already initialised) is fine.
        let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    }

    pub fn available() -> BioStatus {
        init_thread();
        let reason = match UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.join()) {
            Ok(Avail::Available) => {
                return BioStatus {
                    available: true,
                    kind: "hello",
                    reason: None,
                }
            }
            Ok(Avail::DeviceNotPresent) => "device_not_present",
            Ok(Avail::NotConfiguredForUser) => "not_configured",
            Ok(Avail::DisabledByPolicy) => "disabled_by_policy",
            Ok(Avail::DeviceBusy) => "device_busy",
            _ => "failed",
        };
        BioStatus::unavailable(reason)
    }

    pub fn verify(reason: &str) -> BioResult {
        init_thread();
        let message = HSTRING::from(reason);
        match UserConsentVerifier::RequestVerificationAsync(&message).and_then(|op| op.join()) {
            Ok(Verdict::Verified) => BioResult::ok(),
            Ok(Verdict::Canceled) => BioResult::err("cancelled"),
            Ok(Verdict::DeviceNotPresent)
            | Ok(Verdict::NotConfiguredForUser)
            | Ok(Verdict::DisabledByPolicy)
            | Ok(Verdict::DeviceBusy) => BioResult::err("unavailable"),
            _ => BioResult::err("failed"),
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{BioResult, BioStatus};
    use std::sync::mpsc;

    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAError, LAPolicy};

    /// Touch ID only (no password fallback).
    const POLICY: LAPolicy = LAPolicy::DeviceOwnerAuthenticationWithBiometrics;

    pub fn available() -> BioStatus {
        // SAFETY: a fresh context, used only for the policy check.
        let ctx = unsafe { LAContext::new() };
        let can = unsafe { ctx.canEvaluatePolicy_error(POLICY) };
        if can.is_ok() {
            BioStatus {
                available: true,
                kind: "touchid",
                reason: None,
            }
        } else {
            BioStatus::unavailable("unavailable")
        }
    }

    pub fn verify(reason: &str) -> BioResult {
        // SAFETY: the context and reply block live until the reply has been received.
        let ctx = unsafe { LAContext::new() };
        let can = unsafe { ctx.canEvaluatePolicy_error(POLICY) };
        if can.is_err() {
            return BioResult::err("unavailable");
        }
        let (tx, rx) = mpsc::channel::<BioResult>();
        let reply = RcBlock::new(move |ok: Bool, err: *mut NSError| {
            let res = if ok.as_bool() {
                BioResult::ok()
            } else {
                // SAFETY: LAContext passes either null or a valid NSError for the duration of the reply.
                let code = unsafe { err.as_ref() }.map_or(0, |e| e.code());
                BioResult::err(map_error(code))
            };
            let _ = tx.send(res);
        });
        let localized = NSString::from_str(reason);
        // SAFETY: policy and reason are valid; the reply block is retained by the framework while pending.
        unsafe { ctx.evaluatePolicy_localizedReason_reply(POLICY, &localized, &reply) };
        rx.recv().unwrap_or_else(|_| BioResult::err("failed"))
    }

    fn map_error(code: isize) -> &'static str {
        match LAError(code) {
            LAError::UserCancel
            | LAError::SystemCancel
            | LAError::AppCancel
            | LAError::UserFallback => "cancelled",
            LAError::BiometryNotAvailable
            | LAError::BiometryNotEnrolled
            | LAError::BiometryLockout
            | LAError::PasscodeNotSet => "unavailable",
            _ => "failed",
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use super::{BioResult, BioStatus};

    pub fn available() -> BioStatus {
        BioStatus::unavailable("unsupported")
    }

    pub fn verify(_reason: &str) -> BioResult {
        BioResult::err("unsupported")
    }
}

pub fn available() -> BioStatus {
    imp::available()
}

pub fn verify(reason: &str) -> BioResult {
    imp::verify(reason)
}
