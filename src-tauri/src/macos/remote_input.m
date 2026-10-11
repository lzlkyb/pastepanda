#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#include <stdint.h>
#include <unistd.h>
#include <stdatomic.h>
// Tag synthetic events so a session's physical-input observer can ignore them.
static const int64_t PPRemoteTag=0x505052454d4f5445;
bool pp_rc_event_injected(CGEventRef event){return event && (CGEventGetIntegerValueField(event,kCGEventSourceUserData)==PPRemoteTag || CGEventGetIntegerValueField(event,kCGEventSourceUnixProcessID)==getpid());}
extern void pp_rc_lock_start(void);extern void pp_rc_lock_stop(void);extern bool pp_rc_lock_set(bool on);
@interface PPRemoteInput:NSObject @end
@implementation PPRemoteInput @end
static NSMutableSet<NSNumber *> *modifiers;
static uint32_t mouseButtons;
static atomic_bool capsEnabled=false;
static bool capsDown=false;
static CGEventFlags modifierFlag(uint32_t vk){switch(vk){case 0x10:case 0xA0:case 0xA1:return kCGEventFlagMaskShift;case 0x11:case 0xA2:case 0xA3:return kCGEventFlagMaskControl;case 0x12:case 0xA4:case 0xA5:return kCGEventFlagMaskAlternate;case 0x5B:case 0x5C:return kCGEventFlagMaskCommand;default:return 0;}}
int32_t pp_rc_key_code(uint32_t vk){
    static const uint16_t letters[]={kVK_ANSI_A,kVK_ANSI_B,kVK_ANSI_C,kVK_ANSI_D,kVK_ANSI_E,kVK_ANSI_F,kVK_ANSI_G,kVK_ANSI_H,kVK_ANSI_I,kVK_ANSI_J,kVK_ANSI_K,kVK_ANSI_L,kVK_ANSI_M,kVK_ANSI_N,kVK_ANSI_O,kVK_ANSI_P,kVK_ANSI_Q,kVK_ANSI_R,kVK_ANSI_S,kVK_ANSI_T,kVK_ANSI_U,kVK_ANSI_V,kVK_ANSI_W,kVK_ANSI_X,kVK_ANSI_Y,kVK_ANSI_Z};
    static const uint16_t digits[]={kVK_ANSI_0,kVK_ANSI_1,kVK_ANSI_2,kVK_ANSI_3,kVK_ANSI_4,kVK_ANSI_5,kVK_ANSI_6,kVK_ANSI_7,kVK_ANSI_8,kVK_ANSI_9};
    static const uint16_t keypad[]={kVK_ANSI_Keypad0,kVK_ANSI_Keypad1,kVK_ANSI_Keypad2,kVK_ANSI_Keypad3,kVK_ANSI_Keypad4,kVK_ANSI_Keypad5,kVK_ANSI_Keypad6,kVK_ANSI_Keypad7,kVK_ANSI_Keypad8,kVK_ANSI_Keypad9};
    static const uint16_t function[]={kVK_F1,kVK_F2,kVK_F3,kVK_F4,kVK_F5,kVK_F6,kVK_F7,kVK_F8,kVK_F9,kVK_F10,kVK_F11,kVK_F12};
    if(vk>=0x41 && vk<=0x5A)return letters[vk-0x41];if(vk>=0x30 && vk<=0x39)return digits[vk-0x30];if(vk>=0x60 && vk<=0x69)return keypad[vk-0x60];if(vk>=0x70 && vk<=0x7B)return function[vk-0x70];
    switch(vk){case 0x08:return kVK_Delete;case 0x09:return kVK_Tab;case 0x0D:return kVK_Return;case 0x1B:return kVK_Escape;case 0x20:return kVK_Space;
        case 0x21:return kVK_PageUp;case 0x22:return kVK_PageDown;case 0x23:return kVK_End;case 0x24:return kVK_Home;case 0x25:return kVK_LeftArrow;case 0x26:return kVK_UpArrow;case 0x27:return kVK_RightArrow;case 0x28:return kVK_DownArrow;case 0x2E:return kVK_ForwardDelete;
        case 0x10:case 0xA0:return kVK_Shift;case 0xA1:return kVK_RightShift;case 0x11:case 0xA2:return kVK_Control;case 0xA3:return kVK_RightControl;case 0x12:case 0xA4:return kVK_Option;case 0xA5:return kVK_RightOption;case 0x5B:return kVK_Command;case 0x5C:return kVK_RightCommand;
        case 0x14:return kVK_CapsLock;case 0x6A:return kVK_ANSI_KeypadMultiply;case 0x6B:return kVK_ANSI_KeypadPlus;case 0x6D:return kVK_ANSI_KeypadMinus;case 0x6E:return kVK_ANSI_KeypadDecimal;case 0x6F:return kVK_ANSI_KeypadDivide;
        case 0xBA:return kVK_ANSI_Semicolon;case 0xBB:return kVK_ANSI_Equal;case 0xBC:return kVK_ANSI_Comma;case 0xBD:return kVK_ANSI_Minus;case 0xBE:return kVK_ANSI_Period;case 0xBF:return kVK_ANSI_Slash;case 0xC0:return kVK_ANSI_Grave;case 0xDB:return kVK_ANSI_LeftBracket;case 0xDC:return kVK_ANSI_Backslash;case 0xDD:return kVK_ANSI_RightBracket;case 0xDE:return kVK_ANSI_Quote;default:return -1;
    }
}
static CGEventFlags currentFlags(void){CGEventFlags flags=atomic_load(&capsEnabled)?kCGEventFlagMaskAlphaShift:0;for(NSNumber *vk in modifiers)flags|=modifierFlag(vk.unsignedIntValue);return flags;}
static void updateModifierState(uint32_t code,bool down){
    if(modifierFlag(code)){if(down)[modifiers addObject:@(code)];else[modifiers removeObject:@(code)];}
    if(code==0x14){if(down && !capsDown)atomic_store(&capsEnabled,!atomic_load(&capsEnabled));capsDown=down;}
}
static int32_t post(CGEventRef event,CGEventFlags flags){if(!event)return 4;CGEventSetFlags(event,flags);CGEventSetIntegerValueField(event,kCGEventSourceUserData,PPRemoteTag);CGEventPost(kCGHIDEventTap,event);CFRelease(event);return 0;}
int32_t pp_rc_inject(uint32_t kind,double x,double y,uint32_t code,bool down,int32_t delta,const uint16_t *text,size_t units){
    if(!AXIsProcessTrusted() || !CGPreflightPostEventAccess())return 2;
    if(!isfinite(x+y))return 1;
    @synchronized(PPRemoteInput.class){
        if(!modifiers){modifiers=[NSMutableSet new];atomic_store(&capsEnabled,(CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState)&kCGEventFlagMaskAlphaShift)!=0);}CGEventFlags flags=currentFlags();CGPoint point=CGPointMake(x,y);
        switch(kind){
            case 1:{CGEventType type=(mouseButtons&1)?kCGEventLeftMouseDragged:(mouseButtons&2)?kCGEventRightMouseDragged:(mouseButtons&4)?kCGEventOtherMouseDragged:kCGEventMouseMoved;CGMouseButton button=(mouseButtons&1)?kCGMouseButtonLeft:(mouseButtons&2)?kCGMouseButtonRight:kCGMouseButtonCenter;return post(CGEventCreateMouseEvent(NULL,type,point,button),flags);}
            case 2:{if(code<1 || code>3)return 1;if(!down){CGEventRef current=CGEventCreate(NULL);if(!current)return 4;point=CGEventGetLocation(current);CFRelease(current);}CGMouseButton button=code==1?kCGMouseButtonLeft:code==2?kCGMouseButtonRight:kCGMouseButtonCenter;CGEventType type=code==1?(down?kCGEventLeftMouseDown:kCGEventLeftMouseUp):code==2?(down?kCGEventRightMouseDown:kCGEventRightMouseUp):(down?kCGEventOtherMouseDown:kCGEventOtherMouseUp);
                CGEventRef event=CGEventCreateMouseEvent(NULL,type,point,button);if(!event)return 4;if(down)mouseButtons|=1u<<(code-1);else mouseButtons&=~(1u<<(code-1));return post(event,flags);}
            case 3:{if(delta>12000 || delta< -12000)return 1;CGEventRef event=CGEventCreateScrollWheelEvent(NULL,kCGScrollEventUnitPixel,1,delta);if(event)CGEventSetLocation(event,point);return post(event,flags);}
            case 4:{int32_t key=pp_rc_key_code(code);if(key<0)return 3;CGEventRef event=CGEventCreateKeyboardEvent(NULL,(CGKeyCode)key,down);if(!event)return 4;
                updateModifierState(code,down);return post(event,currentFlags());}
            case 5:{if(!text || !units || units>512)return 1;CGEventRef press=CGEventCreateKeyboardEvent(NULL,0,true),release=CGEventCreateKeyboardEvent(NULL,0,false);if(!press || !release){if(press)CFRelease(press);if(release)CFRelease(release);return 4;}
                CGEventKeyboardSetUnicodeString(press,units,text);CGEventKeyboardSetUnicodeString(release,units,text);post(press,0);return post(release,0);}
            default:return 1;
        }
    }
}

#include <stdatomic.h>
static id globalWatch,localWatch;
static atomic_bool watching=false;
static atomic_uint_fast64_t watchGeneration=0;
static atomic_uint_fast64_t lastKeyboard=0,lastMouse=0;
static void observe(NSEvent *event){
    if(!atomic_load(&watching))return;
    CGEventRef native=event.CGEvent;if(pp_rc_event_injected(native))return;
    atomic_store(&capsEnabled,(event.modifierFlags&NSEventModifierFlagCapsLock)!=0);
    uint64_t time=(uint64_t)(NSDate.date.timeIntervalSince1970*1000);
    if(event.type==NSEventTypeKeyDown || event.type==NSEventTypeKeyUp)atomic_store(&lastKeyboard,time);else atomic_store(&lastMouse,time);
}
int32_t pp_rc_watch_start(void){
    if(!NSApp)return 4;
    uint64_t generation=atomic_fetch_add(&watchGeneration,1)+1;
    void (^start)(void)=^{
        if(atomic_load(&watchGeneration)!=generation)return;
        if(globalWatch)[NSEvent removeMonitor:globalWatch];if(localWatch)[NSEvent removeMonitor:localWatch];globalWatch=nil;localWatch=nil;
        atomic_store(&lastKeyboard,0);atomic_store(&lastMouse,0);
        NSEventMask mask=NSEventMaskMouseMoved|NSEventMaskLeftMouseDragged|NSEventMaskRightMouseDragged|NSEventMaskOtherMouseDragged|NSEventMaskLeftMouseDown|NSEventMaskRightMouseDown|NSEventMaskOtherMouseDown|NSEventMaskScrollWheel;
        if(AXIsProcessTrusted())mask|=NSEventMaskKeyDown|NSEventMaskKeyUp;
        globalWatch=[NSEvent addGlobalMonitorForEventsMatchingMask:mask handler:^(NSEvent *event){observe(event);}];
        localWatch=[NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent *(NSEvent *event){observe(event);return event;}];
        atomic_store(&watching,globalWatch!=nil);
        pp_rc_lock_start();
    };if(NSThread.isMainThread){start();return atomic_load(&watching)?0:4;}else{dispatch_async(dispatch_get_main_queue(),start);return 0;}
}
void pp_rc_watch_stop(void){
    uint64_t generation=atomic_fetch_add(&watchGeneration,1)+1;atomic_store(&watching,false);pp_rc_lock_set(false);
    void (^stop)(void)=^{if(atomic_load(&watchGeneration)!=generation)return;pp_rc_lock_stop();if(globalWatch)[NSEvent removeMonitor:globalWatch];if(localWatch)[NSEvent removeMonitor:localWatch];globalWatch=nil;localWatch=nil;};
    if(NSApp){if(NSThread.isMainThread)stop();else dispatch_async(dispatch_get_main_queue(),stop);}
    @synchronized(PPRemoteInput.class){[modifiers removeAllObjects];mouseButtons=0;capsDown=false;}
}
bool pp_rc_watching(void){return atomic_load(&watching);}
uint64_t pp_rc_last_keyboard(void){return atomic_load(&lastKeyboard);}
uint64_t pp_rc_last_mouse(void){return atomic_load(&lastMouse);}
