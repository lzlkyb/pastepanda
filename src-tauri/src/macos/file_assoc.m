#import <AppKit/AppKit.h>
#import <CoreServices/CoreServices.h>
#include <stdint.h>
static CFStringRef markdownType(void){return CFSTR("net.daringfireball.markdown");}
int32_t pp_mac_md_snapshot(uint8_t **output,size_t *length){
    if(!output || !length)return 1;*output=NULL;*length=0;
    @autoreleasepool{
        NSBundle *bundle=NSBundle.mainBundle;NSString *identifier=bundle.bundleIdentifier;
        if(!identifier.length || ![bundle.bundlePath.pathExtension isEqualToString:@"app"])return 8;
        NSString *current=CFBridgingRelease(LSCopyDefaultRoleHandlerForContentType(markdownType(),kLSRolesAll));
        NSData *json=[NSJSONSerialization dataWithJSONObject:@{@"bundle_id":identifier,@"current":current?:NSNull.null} options:0 error:nil];
        if(!json || json.length>8192)return 1;uint8_t *bytes=malloc(json.length);if(!bytes)return 1;
        memcpy(bytes,json.bytes,json.length);*output=bytes;*length=json.length;return 0;
    }
}
int32_t pp_mac_md_set(const uint8_t *bytes,size_t length){
    if(!bytes || !length || length>512)return 1;
    @autoreleasepool{
        NSString *identifier=[[NSString alloc] initWithBytes:bytes length:length encoding:NSUTF8StringEncoding];
        NSBundle *bundle=NSBundle.mainBundle;
        if(!identifier.length || !bundle.bundleIdentifier.length || ![bundle.bundlePath.pathExtension isEqualToString:@"app"])return 8;
        if([identifier caseInsensitiveCompare:bundle.bundleIdentifier]==NSOrderedSame){
            OSStatus status=LSRegisterURL((__bridge CFURLRef)bundle.bundleURL,true);if(status)return status;
        }else{
            CFArrayRef apps=LSCopyApplicationURLsForBundleIdentifier((__bridge CFStringRef)identifier,NULL);
            BOOL available=apps && CFArrayGetCount(apps)>0;if(apps)CFRelease(apps);if(!available)return 6;
        }
        OSStatus status=LSSetDefaultRoleHandlerForContentType(markdownType(),kLSRolesAll,(__bridge CFStringRef)identifier);
        if(status)return status;
        NSString *actual=CFBridgingRelease(LSCopyDefaultRoleHandlerForContentType(markdownType(),kLSRolesAll));
        return actual && [actual caseInsensitiveCompare:identifier]==NSOrderedSame?0:4;
    }
}
