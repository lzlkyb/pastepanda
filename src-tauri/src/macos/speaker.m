#include <stdint.h>
#include <stdbool.h>
#import <CoreAudio/CoreAudio.h>
static int32_t defaultOutput(AudioDeviceID *device){
    AudioObjectPropertyAddress address={kAudioHardwarePropertyDefaultOutputDevice,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
    UInt32 size=sizeof(*device);*device=kAudioObjectUnknown;
    return AudioObjectGetPropertyData(kAudioObjectSystemObject,&address,0,NULL,&size,device)==noErr && *device!=kAudioObjectUnknown?0:1;
}
static AudioObjectPropertyAddress muteAddress(void){return (AudioObjectPropertyAddress){kAudioDevicePropertyMute,kAudioDevicePropertyScopeOutput,kAudioObjectPropertyElementMain};}
static int32_t readMute(AudioDeviceID device,bool *muted){
    AudioObjectPropertyAddress address=muteAddress();UInt32 value=0,size=sizeof(value);
    if(AudioObjectGetPropertyData(device,&address,0,NULL,&size,&value)!=noErr)return 1;
    *muted=value!=0;return 0;
}
int32_t pp_rc_speaker_muted(bool *muted){
    if(!muted)return 1;AudioDeviceID device;if(defaultOutput(&device))return 1;return readMute(device,muted);
}
int32_t pp_rc_speaker_set(bool on,bool *actual){
    if(!actual)return 1;AudioDeviceID device;if(defaultOutput(&device))return 1;
    AudioObjectPropertyAddress address=muteAddress();Boolean writable=false;
    if(AudioObjectIsPropertySettable(device,&address,&writable)!=noErr || !writable)return 2;
    UInt32 value=on?1:0;
    if(AudioObjectSetPropertyData(device,&address,0,NULL,sizeof(value),&value)!=noErr)return 3;
    if(readMute(device,actual) || *actual!=on)return 4;
    return 0;
}
