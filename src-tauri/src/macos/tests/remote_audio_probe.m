#import "../remote_audio_encoder.h"
#include <assert.h>
int main(int argc,char **argv){@autoreleasepool{
    PPRemoteAudioEncoder *encoder=[PPRemoteAudioEncoder new];
    AVAudioFormat *format=[[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:48000 channels:2 interleaved:YES];
    AVAudioPCMBuffer *pcm=[[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:4800];pcm.frameLength=4800;
    for(int i=0;i<4800;i++){float signal=.2*sin(i*2*M_PI*440/48000);((float *)pcm.mutableAudioBufferList->mBuffers[0].mData)[i*2]=signal;((float *)pcm.mutableAudioBufferList->mBuffers[0].mData)[i*2+1]=signal;}
    CMAudioFormatDescriptionRef description=NULL;assert(CMAudioFormatDescriptionCreate(NULL,format.streamDescription,0,NULL,0,NULL,NULL,&description)==0);
    for(int i=0;i<30;i++){
        CMBlockBufferRef block=NULL;assert(CMBlockBufferCreateWithMemoryBlock(NULL,NULL,4800*2*sizeof(float),NULL,NULL,0,4800*2*sizeof(float),0,&block)==0);
        assert(CMBlockBufferReplaceDataBytes(pcm.audioBufferList->mBuffers[0].mData,block,0,4800*2*sizeof(float))==0);
        CMSampleBufferRef sample=NULL;assert(CMAudioSampleBufferCreateReadyWithPacketDescriptions(NULL,block,description,4800,CMTimeMake(i*4800,48000),NULL,&sample)==0);CFRelease(block);
        assert([encoder append:sample]);CFRelease(sample);
    }
    assert(encoder.packets.count==64 && encoder.times.count==64);
    uint64_t previous=0;for(NSUInteger i=0;i<encoder.packets.count;i++){assert(encoder.packets[i].length>0);uint64_t now=encoder.times[i].unsignedLongLongValue;assert(now>previous);previous=now;}
    if(argc==2){NSMutableArray *items=[NSMutableArray new];for(NSUInteger i=0;i<encoder.packets.count;i++)[items addObject:@{@"data":[encoder.packets[i] base64EncodedStringWithOptions:0],@"timestamp":encoder.times[i]}];NSData *json=[NSJSONSerialization dataWithJSONObject:items options:0 error:nil];assert([json writeToFile:[NSString stringWithUTF8String:argv[1]] atomically:YES]);}
    assert(![encoder append:NULL]);CFRelease(description);
    puts("PASS: actual native AAC encoder emits packets with monotonic timestamps and bounded backlog (synthetic PCM, no system capture)");
}return 0;}
