#import <IOKit/pwr_mgt/IOPMLib.h>
#include <assert.h>
static int creates,releases,failAt;
static IOReturn fakeCreate(CFStringRef type,IOPMAssertionLevel level,CFStringRef name,IOPMAssertionID *output){if(++creates==failAt)return kIOReturnError;*output=100+creates;return kIOReturnSuccess;}
static IOReturn fakeRelease(IOPMAssertionID id){assert(id==101 || id==102);releases++;return kIOReturnSuccess;}
#define IOPMAssertionCreateWithName fakeCreate
#define IOPMAssertionRelease fakeRelease
#include "../keep_awake.m"
int main(){uint32_t system=0,display=0;
    assert(pp_mac_awake_start(&system,&display)==0 && system==101 && display==102);pp_mac_awake_stop(system,display);assert(releases==2);
    creates=releases=0;failAt=2;assert(pp_mac_awake_start(&system,&display)==2 && !system && !display && releases==1);
    creates=releases=0;failAt=1;assert(pp_mac_awake_start(&system,&display)==2 && releases==0);
    puts("PASS: power guard acquires both assertions, releases owned IDs and rolls back a partial failure (fake IOKit, no power setting changed)");return 0;
}
