#import <ApplicationServices/ApplicationServices.h>
#include <assert.h>
#include "../remote_input_lock.m"
bool pp_rc_event_injected(CGEventRef event){return false;}
bool pp_rc_should_swallow(bool injected,bool own,bool gate){return gate && !injected && !own;}
int main(){@autoreleasepool{
    // No tap is installed, no events are posted, and no OS settings are changed.
    assert(!pp_rc_lock_set(true));atomic_store(&locked,true);atomic_store(&lease,monotonicMS()-1);assert(!pp_rc_lock_active());
    atomic_store(&locked,true);atomic_store(&lease,monotonicMS()+15000);assert(pp_rc_lock_active());
    tapEvent(NULL,kCGEventTapDisabledByTimeout,NULL,NULL);assert(!pp_rc_lock_active());
    CGEventRef event=CGEventCreateKeyboardEvent(NULL,53,true);CGEventSetFlags(event,kCGEventFlagMaskControl|kCGEventFlagMaskAlternate);
    atomic_store(&locked,true);atomic_store(&lease,monotonicMS()+15000);
    assert(tapEvent(NULL,kCGEventKeyDown,event,NULL)==event && !pp_rc_lock_active());CFRelease(event);
    assert(pp_rc_lock_set(false)==false);pp_rc_lock_stop();assert(!pp_rc_lock_active());
    puts("PASS: absent tap cannot claim lock; expired lease, tap timeout and Control+Option+Esc release it (no tap installed, no input posted)");return 0;
}}
