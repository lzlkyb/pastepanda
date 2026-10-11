#define AudioObjectGetPropertyData FakeGet
#define AudioObjectSetPropertyData FakeSet
#define AudioObjectIsPropertySettable FakeWritable
#include "../speaker.m"
#include <assert.h>
static bool writable=true,writeFailure=false,readFailure=false;
static UInt32 mute=0;static int writes=0;static AudioDeviceID selected=42,lastWrite=0,lastRead=0;
OSStatus FakeGet(AudioObjectID object,const AudioObjectPropertyAddress *address,UInt32 qualifierSize,const void *qualifier,UInt32 *size,void *output){
    if(address->mSelector==kAudioHardwarePropertyDefaultOutputDevice){*(AudioDeviceID *)output=selected;return noErr;}
    lastRead=object;if(readFailure)return kAudioHardwareIllegalOperationError;
    *(UInt32 *)output=mute;return noErr;
}
OSStatus FakeSet(AudioObjectID object,const AudioObjectPropertyAddress *address,UInt32 qualifierSize,const void *qualifier,UInt32 size,const void *input){
    writes++;lastWrite=object;if(writeFailure)return kAudioHardwareIllegalOperationError;
    mute=*(const UInt32 *)input;selected=43;return noErr; // Default output switches while the write is in flight.
}
OSStatus FakeWritable(AudioObjectID object,const AudioObjectPropertyAddress *address,Boolean *output){*output=writable;return noErr;}
int main(){
    bool actual=false;assert(pp_rc_speaker_set(true,&actual)==0 && actual && lastWrite==42 && lastRead==42);
    writable=false;int before=writes;assert(pp_rc_speaker_set(false,&actual)==2 && writes==before);
    writable=true;writeFailure=true;assert(pp_rc_speaker_set(false,&actual)==3);
    writeFailure=false;readFailure=true;assert(pp_rc_speaker_set(false,&actual)==4);
    assert(pp_rc_speaker_set(false,NULL)==1);
    puts("PASS: speaker mutation pins one device, checks writable state and reports rejected/unconfirmed writes (fake CoreAudio, no system setting changed)");return 0;
}
