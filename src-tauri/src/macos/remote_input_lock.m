#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <stdatomic.h>
#include <time.h>
extern bool pp_rc_event_injected(CGEventRef event);
extern bool pp_rc_should_swallow(bool injected,bool own,bool gate);
static CFMachPortRef lockTap;
static CFRunLoopSourceRef lockSource;
static atomic_bool locked=false;
static atomic_uint_fast64_t lease=0;
static uint64_t monotonicMS(void){struct timespec now;if(clock_gettime(CLOCK_MONOTONIC,&now))return 0;return (uint64_t)now.tv_sec*1000+now.tv_nsec/1000000;}
bool pp_rc_lock_active(void){
    uint64_t now=monotonicMS();if(!now || now>=atomic_load(&lease))atomic_store(&locked,false);
    return atomic_load(&locked);
}
void pp_rc_lock_refresh(void){if(pp_rc_lock_active())atomic_store(&lease,monotonicMS()+15000);}
static bool emergency(CGEventRef event){
    CGEventFlags flags=CGEventGetFlags(event);
    return CGEventGetIntegerValueField(event,kCGKeyboardEventKeycode)==53 && (flags&kCGEventFlagMaskControl) && (flags&kCGEventFlagMaskAlternate);
}
static bool targetsOwnUI(CGEventType type,CGEventRef event){
    if(!NSApp)return true;
    if(type==kCGEventKeyDown || type==kCGEventKeyUp || type==kCGEventFlagsChanged){
        pid_t pid=NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;return pid<=0 || pid==getpid();
    }
    CGPoint point=CGEventGetLocation(event);point.y=CGDisplayBounds(CGMainDisplayID()).size.height-point.y;
    for(NSWindow *window in NSApp.windows)if(window.visible && !window.ignoresMouseEvents && CGRectContainsPoint(NSRectToCGRect(window.frame),point))return true;
    return false;
}
static CGEventRef tapEvent(CGEventTapProxy proxy,CGEventType type,CGEventRef event,void *context){
    if(type==kCGEventTapDisabledByTimeout || type==kCGEventTapDisabledByUserInput){atomic_store(&locked,false);return event;}
    if(!event || pp_rc_event_injected(event))return event;
    if(type==kCGEventKeyDown && emergency(event)){atomic_store(&locked,false);return event;}
    return pp_rc_should_swallow(false,targetsOwnUI(type,event),pp_rc_lock_active())?NULL:event;
}
void pp_rc_lock_stop(void){
    atomic_store(&locked,false);atomic_store(&lease,0);
    if(lockTap){CGEventTapEnable(lockTap,false);if(lockSource){CFRunLoopRemoveSource(CFRunLoopGetMain(),lockSource,kCFRunLoopCommonModes);CFRelease(lockSource);lockSource=NULL;}CFMachPortInvalidate(lockTap);CFRelease(lockTap);lockTap=NULL;}
}
void pp_rc_lock_start(void){
    pp_rc_lock_stop();if(!NSApp || !AXIsProcessTrusted())return;
    CGEventMask mask=CGEventMaskBit(kCGEventKeyDown)|CGEventMaskBit(kCGEventKeyUp)|CGEventMaskBit(kCGEventFlagsChanged)|CGEventMaskBit(kCGEventMouseMoved)|CGEventMaskBit(kCGEventLeftMouseDown)|CGEventMaskBit(kCGEventLeftMouseUp)|CGEventMaskBit(kCGEventRightMouseDown)|CGEventMaskBit(kCGEventRightMouseUp)|CGEventMaskBit(kCGEventOtherMouseDown)|CGEventMaskBit(kCGEventOtherMouseUp)|CGEventMaskBit(kCGEventLeftMouseDragged)|CGEventMaskBit(kCGEventRightMouseDragged)|CGEventMaskBit(kCGEventOtherMouseDragged)|CGEventMaskBit(kCGEventScrollWheel);
    lockTap=CGEventTapCreate(kCGSessionEventTap,kCGHeadInsertEventTap,kCGEventTapOptionDefault,mask,tapEvent,NULL);
    if(!lockTap)return;lockSource=CFMachPortCreateRunLoopSource(NULL,lockTap,0);
    if(!lockSource){pp_rc_lock_stop();return;}CFRunLoopAddSource(CFRunLoopGetMain(),lockSource,kCFRunLoopCommonModes);CGEventTapEnable(lockTap,true);
}
bool pp_rc_lock_set(bool on){
    if(!on){atomic_store(&locked,false);return false;}
    __block bool result=false;void (^set)(void)=^{
        if(!lockTap || !AXIsProcessTrusted())return;
        CGEventTapEnable(lockTap,true);if(!CGEventTapIsEnabled(lockTap))return;
        atomic_store(&lease,monotonicMS()+15000);atomic_store(&locked,true);result=true;
    };
    if(NSThread.isMainThread)set();else dispatch_sync(dispatch_get_main_queue(),set);return result;
}
