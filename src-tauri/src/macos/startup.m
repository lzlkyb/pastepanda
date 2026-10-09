#import <AppKit/AppKit.h>
#import <ServiceManagement/ServiceManagement.h>
#include <stdint.h>
// 0 disabled, 1 enabled, 2 needs user approval, 3 missing bundle, -1 unsupported.
int32_t pp_mac_startup_status(void) {
    if (@available(macOS 13.0, *)) {
        if (![NSBundle.mainBundle.bundlePath.pathExtension isEqualToString:@"app"]) return 3;
        switch (SMAppService.mainAppService.status) {
            case SMAppServiceStatusNotRegistered: return 0;
            case SMAppServiceStatusEnabled: return 1;
            case SMAppServiceStatusRequiresApproval: return 2;
            default: return 3;
        }
    }
    return -1;
}
int32_t pp_mac_startup_set(bool enable) {
    if (@available(macOS 13.0, *)) {
        int32_t status = pp_mac_startup_status();
        if (status == 3) return 3;
        if ((enable && status == 1) || (!enable && status == 0)) return 0;
        NSError *error = nil;
        BOOL success = enable ? [SMAppService.mainAppService registerAndReturnError:&error]
                              : [SMAppService.mainAppService unregisterAndReturnError:&error];
        if (enable && pp_mac_startup_status() == 2) return 2;
        return success ? 0 : 4;
    }
    return -1;
}
