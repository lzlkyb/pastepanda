#import <AppKit/AppKit.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <ApplicationServices/ApplicationServices.h>
#import <dispatch/dispatch.h>
#include <stdint.h>
#include <unistd.h>

// No permission prompts or clipboard writes: the caller checks before writing.
int32_t pp_mac_frontmost_pid(void) {
    @autoreleasepool {
        return NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    }
}
bool pp_mac_accessibility_trusted(void) { return AXIsProcessTrusted(); }
bool pp_mac_target_valid(int32_t pid, uint32_t own_pid) {
    if (pid <= 0 || (uint32_t)pid == own_pid || !AXIsProcessTrusted()) return false;
    @autoreleasepool {
        NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
        if (!app || app.terminated || app.activationPolicy != NSApplicationActivationPolicyRegular) return false;
        AXUIElementRef element = AXUIElementCreateApplication(pid);
        CFTypeRef window = NULL;
        AXError error = AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute, &window);
        if (window) CFRelease(window);
        CFRelease(element);
        return error == kAXErrorSuccess && window != NULL;
    }
}
int32_t pp_mac_activate_target(int32_t pid) {
    if (!AXIsProcessTrusted()) return 1;
    if (!pp_mac_target_valid(pid, (uint32_t)getpid())) return 2;
    __block BOOL activated = NO;
    void (^activate)(void) = ^{
        @autoreleasepool {
            NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
            activated = [app activateWithOptions:0];
        }
    };
    if (NSThread.isMainThread) activate();
    else dispatch_sync(dispatch_get_main_queue(), activate);
    return activated ? 0 : 3;
}
static int32_t sendTargetKey(int32_t pid, CGKeyCode key, CGEventFlags flags) {
    if (!AXIsProcessTrusted()) return 1;
    if (!pp_mac_target_valid(pid, (uint32_t)getpid()) || pp_mac_frontmost_pid() != pid) return 2;
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
    if (!source) return 4;
    CGEventRef down = CGEventCreateKeyboardEvent(source, key, true);
    CGEventRef up = CGEventCreateKeyboardEvent(source, key, false);
    if (!down || !up) {
        if (down) CFRelease(down);
        if (up) CFRelease(up);
        CFRelease(source);
        return 4;
    }
    CGEventSetFlags(down, flags);
    CGEventSetFlags(up, flags);
    CGEventPostToPid(pid, down);
    CGEventPostToPid(pid, up);
    CFRelease(down);
    CFRelease(up);
    CFRelease(source);
    return 0;
}

int32_t pp_mac_send_paste(int32_t pid) { return sendTargetKey(pid, 9, kCGEventFlagMaskCommand); }
int32_t pp_mac_send_tab(int32_t pid) { return sendTargetKey(pid, 48, 0); }

#import <Security/Security.h>
#include <string.h>
int32_t pp_mac_keychain_read(uint8_t *key, size_t capacity) {
    if (!key || capacity != 32) return errSecParam;
    // Legacy login-Keychain ACLs can ignore LAContext noninteraction. Fail closed
    // if the legacy API cannot disable interaction before touching an item.
    OSStatus policy = SecKeychainSetUserInteractionAllowed(false);
    if (policy != errSecSuccess) return policy;
    @autoreleasepool {
        LAContext *context = [LAContext new];
        context.interactionNotAllowed = YES;
        NSDictionary *query = @{
            (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: @"com.pastepanda.app.encryption",
            (__bridge id)kSecAttrAccount: @"local-key-v1",
            (__bridge id)kSecReturnData: @YES,
            (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
            // Explicit policy also covers legacy login-Keychain ACL authorization.
            (__bridge id)kSecUseAuthenticationUI: (__bridge id)kSecUseAuthenticationUIFail,
            (__bridge id)kSecUseAuthenticationContext: context
        };
        CFTypeRef result = NULL;
        OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
        if (status != errSecSuccess) return status;
        if (!result || CFGetTypeID(result) != CFDataGetTypeID() || CFDataGetLength((CFDataRef)result) != 32) {
            if (result) CFRelease(result);
            return errSecDecode;
        }
        memcpy(key, CFDataGetBytePtr((CFDataRef)result), 32);
        CFRelease(result);
        return errSecSuccess;
    }
}
int32_t pp_mac_keychain_create(const uint8_t *key, size_t length) {
    if (!key || length != 32) return errSecParam;
    OSStatus policy = SecKeychainSetUserInteractionAllowed(false);
    if (policy != errSecSuccess) return policy;
    @autoreleasepool {
        LAContext *context = [LAContext new];
        context.interactionNotAllowed = YES;
        NSDictionary *item = @{
            (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: @"com.pastepanda.app.encryption",
            (__bridge id)kSecAttrAccount: @"local-key-v1",
            (__bridge id)kSecAttrLabel: @"PastePanda local encryption key",
            (__bridge id)kSecUseAuthenticationUI: (__bridge id)kSecUseAuthenticationUIFail,
            (__bridge id)kSecUseAuthenticationContext: context,
            (__bridge id)kSecValueData: [NSData dataWithBytes:key length:length]
        };
        return SecItemAdd((__bridge CFDictionaryRef)item, NULL);
    }
}

int32_t pp_mac_write_clipboard(const uint8_t *json, size_t length, bool files) {
    @autoreleasepool {
        NSData *data = [NSData dataWithBytes:json length:length];
        id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        if (![value isKindOfClass:NSArray.class]) return 1;
        NSArray *values = value;
        NSPasteboard *board = NSPasteboard.generalPasteboard;
        if (files) {
            if (values.count == 0) return 1;
            NSMutableArray<NSURL *> *urls = [NSMutableArray array];
            for (id path in values) {
                if (![path isKindOfClass:NSString.class] || ![path isAbsolutePath] ||
                    ![NSFileManager.defaultManager fileExistsAtPath:path]) return 1;
                [urls addObject:[NSURL fileURLWithPath:path]];
            }
            [board clearContents];
            return [board writeObjects:urls] ? 0 : 2;
        }
        if (values.count != 2 || ![values[0] isKindOfClass:NSString.class] ||
            ![values[1] isKindOfClass:NSString.class]) return 1;
        NSPasteboardItem *item = [NSPasteboardItem new];
        if (![item setString:values[0] forType:NSPasteboardTypeHTML] ||
            ![item setString:values[1] forType:NSPasteboardTypeString]) return 2;
        [board clearContents];
        return [board writeObjects:@[item]] ? 0 : 2;
    }
}

void pp_mac_free(void *memory) { free(memory); }
int64_t pp_mac_clipboard_change_count(void) {
    @autoreleasepool { return NSPasteboard.generalPasteboard.changeCount; }
}
int32_t pp_mac_clipboard_snapshot(uint8_t **output, size_t *length) {
    if (!output || !length) return 1;
    *output = NULL; *length = 0;
    @autoreleasepool {
        NSPasteboard *board = NSPasteboard.generalPasteboard;
        NSInteger before = board.changeCount;
        NSMutableArray<NSString *> *files = [NSMutableArray array];
        for (NSURL *url in [board readObjectsForClasses:@[NSURL.class]
                                                options:@{NSPasteboardURLReadingFileURLsOnlyKey:@YES}]) {
            if (url.fileURL && url.path) [files addObject:url.path];
        }
        NSRunningApplication *app = NSWorkspace.sharedWorkspace.frontmostApplication;
        NSDictionary *snapshot = @{
            @"change_count": @(before),
            @"text": [board stringForType:NSPasteboardTypeString] ?: @"",
            @"html": [board stringForType:NSPasteboardTypeHTML] ?: @"",
            @"files": files,
            @"source": app.localizedName ?: @"",
            @"executable": app.executableURL.path ?: @""
        };
        NSData *data = [NSJSONSerialization dataWithJSONObject:snapshot options:0 error:nil];
        if (board.changeCount != before) return 2;
        if (!data || data.length > 16 * 1024 * 1024) return 3;
        uint8_t *buffer = malloc(data.length);
        if (!buffer) return 4;
        memcpy(buffer, data.bytes, data.length);
        *output = buffer; *length = data.length;
        return 0;
    }
}

// Read metadata for the resolved paste target, rather than a newer frontmost app.
int32_t pp_mac_application_info(int32_t pid, uint8_t **output, size_t *length) {
    if (!output || !length || pid <= 0) return 1;
    *output = NULL; *length = 0;
    @autoreleasepool {
        NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
        if (!app || app.terminated) return 2;
        NSDictionary *info = @{ @"name": app.localizedName ?: @"",
                                @"bundle_id": app.bundleIdentifier ?: @"" };
        NSData *data = [NSJSONSerialization dataWithJSONObject:info options:0 error:nil];
        if (!data) return 3;
        uint8_t *buffer = malloc(data.length);
        if (!buffer) return 4;
        memcpy(buffer, data.bytes, data.length);
        *output = buffer; *length = data.length;
        return 0;
    }
}

int32_t pp_mac_application_icon(const char *path, uint8_t **output, size_t *length) {
    if (!path || !output || !length) return 1;
    *output = NULL; *length = 0;
    NSString *file = [NSString stringWithUTF8String:path];
    if (!file || ![NSFileManager.defaultManager fileExistsAtPath:file]) return 2;
    // Executable paths normally live under Foo.app/Contents/MacOS; use the bundle icon.
    NSString *bundle = file;
    while (bundle.length > 1 && ![bundle.pathExtension.lowercaseString isEqualToString:@"app"])
        bundle = bundle.stringByDeletingLastPathComponent;
    if (bundle.length <= 1) bundle = file;
    __block NSData *data;
    void (^render)(void) = ^{ @autoreleasepool {
        NSImage *icon = [NSWorkspace.sharedWorkspace iconForFile:bundle];
        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
            pixelsWide:64 pixelsHigh:64 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES
            isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
        if (!icon || !bitmap) return;
        [NSGraphicsContext saveGraphicsState];
        [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap]];
        [icon drawInRect:NSMakeRect(0,0,64,64) fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1];
        [NSGraphicsContext restoreGraphicsState];
        data = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    }};
    if (NSThread.isMainThread) render(); else dispatch_sync(dispatch_get_main_queue(), render);
    if (!data || data.length > 1024*1024) return 3;
    uint8_t *buffer = malloc(data.length);
    if (!buffer) return 4;
    memcpy(buffer, data.bytes, data.length);
    *output = buffer; *length = data.length;
    return 0;
}
