#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#include <assert.h>
#include <stdint.h>
#include "../remote_input.m"
void pp_rc_lock_start(void){}
void pp_rc_lock_stop(void){}
bool pp_rc_lock_set(bool on){return false;}
int main(){
    assert(pp_rc_key_code(0x41)==kVK_ANSI_A && pp_rc_key_code(0x5A)==kVK_ANSI_Z);
    assert(pp_rc_key_code(0x11)==kVK_Control && pp_rc_key_code(0x5B)==kVK_Command && pp_rc_key_code(0xA5)==kVK_RightOption);
    assert(pp_rc_key_code(0x2E)==kVK_ForwardDelete && pp_rc_key_code(0x08)==kVK_Delete);
    assert(pp_rc_key_code(0xBA)==kVK_ANSI_Semicolon && pp_rc_key_code(0x70)==kVK_F1 && pp_rc_key_code(0x7B)==kVK_F12);
    assert(pp_rc_key_code(0x10000)==-1 && pp_rc_key_code(0)==-1);
    modifiers=[NSMutableSet new];atomic_store(&capsEnabled,false);
    updateModifierState(0xA0,true);updateModifierState(0xA1,true);updateModifierState(0xA0,false);assert(currentFlags()&kCGEventFlagMaskShift);
    updateModifierState(0xA1,false);assert(!(currentFlags()&kCGEventFlagMaskShift));
    updateModifierState(0x14,true);assert(currentFlags()&kCGEventFlagMaskAlphaShift);updateModifierState(0x14,true);assert(currentFlags()&kCGEventFlagMaskAlphaShift);
    updateModifierState(0x14,false);assert(currentFlags()&kCGEventFlagMaskAlphaShift);updateModifierState(0x14,true);assert(!(currentFlags()&kCGEventFlagMaskAlphaShift));
    puts("PASS: Windows wire key codes map to native Mac physical keys; unsupported keys rejected (no events injected)");return 0;
}
