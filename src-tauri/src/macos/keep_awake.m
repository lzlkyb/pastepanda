#import <Foundation/Foundation.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#include <stdint.h>
int32_t pp_mac_awake_start(uint32_t *system,uint32_t *display){
    if(!system || !display)return 1;*system=0;*display=0;
    IOPMAssertionID first=kIOPMNullAssertionID,second=kIOPMNullAssertionID;
    if(IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep,kIOPMAssertionLevelOn,CFSTR("PastePanda remote session"),&first)!=kIOReturnSuccess)return 2;
    if(IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep,kIOPMAssertionLevelOn,CFSTR("PastePanda remote display"),&second)!=kIOReturnSuccess){IOPMAssertionRelease(first);return 2;}
    *system=first;*display=second;return 0;
}
void pp_mac_awake_stop(uint32_t system,uint32_t display){if(display)IOPMAssertionRelease(display);if(system)IOPMAssertionRelease(system);}
