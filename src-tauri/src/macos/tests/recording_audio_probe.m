#import <Foundation/Foundation.h>
#import "../recording_audio.h"
#include <assert.h>
@interface FakeAudio : NSObject
@property(getter=isReadyForMoreMediaData) BOOL readyForMoreMediaData;
@property NSMutableData *pcm;
@property NSMutableArray *times;
- (BOOL)appendSampleBuffer:(CMSampleBufferRef)sample;
@end
@implementation FakeAudio
- (BOOL)appendSampleBuffer:(CMSampleBufferRef)sample {
    [self.times addObject:@(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)))];
    CMBlockBufferRef block=CMSampleBufferGetDataBuffer(sample);size_t n=CMBlockBufferGetDataLength(block);
    NSMutableData *bytes=[NSMutableData dataWithLength:n];assert(CMBlockBufferCopyDataBytes(block,0,n,bytes.mutableBytes)==noErr);
    [self.pcm appendData:bytes];return YES;
}
@end
static CMSampleBufferRef sample(double rate,int channels,int count,float value,double seconds){
    AVAudioFormat *fmt=[[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:rate channels:channels interleaved:YES];
    CMBlockBufferRef block=NULL;CMAudioFormatDescriptionRef desc=NULL;CMSampleBufferRef result=NULL;
    assert(CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault,NULL,count*channels*sizeof(float),kCFAllocatorDefault,NULL,0,count*channels*sizeof(float),0,&block)==noErr);
    NSMutableData *data=[NSMutableData dataWithLength:count*channels*sizeof(float)];float *p=data.mutableBytes;for(int i=0;i<count*channels;i++)p[i]=value;
    assert(CMBlockBufferReplaceDataBytes(p,block,0,data.length)==noErr);
    assert(CMAudioFormatDescriptionCreate(kCFAllocatorDefault,fmt.streamDescription,0,NULL,0,NULL,NULL,&desc)==noErr);
    assert(CMAudioSampleBufferCreateReadyWithPacketDescriptions(kCFAllocatorDefault,block,desc,count,CMTimeMakeWithSeconds(seconds,48000),NULL,&result)==noErr);
    CFRelease(block);CFRelease(desc);return result;
}
static FakeAudio *input(void){FakeAudio *f=[FakeAudio new];f.readyForMoreMediaData=YES;f.pcm=[NSMutableData new];f.times=[NSMutableArray new];return f;}
int main(){@autoreleasepool{
    FakeAudio *f=input();PPRecordingAudio *mix=[[PPRecordingAudio alloc] initWithInput:(id)f epoch:CMTimeMake(100,1)];
    for(int i=0;i<10;i++){
        CMSampleBufferRef sys=sample(48000,2,4800,.4,100+i*.1),mic=sample(48000,2,4800,.3,100+i*.1);
        assert([mix append:sys at:CMTimeMakeWithSeconds(100+i*.1,48000) microphone:NO]);
        assert([mix append:mic at:CMTimeMakeWithSeconds(100+i*.1,48000) microphone:YES]);CFRelease(sys);CFRelease(mic);
    }
    assert([mix flushThrough:CMTimeMake(101,1)]);assert(f.pcm.length==48000*2*sizeof(float));
    const float *p=f.pcm.bytes;for(int i=0;i<48000*2;i++)assert(fabs(p[i]-.7)<.0001);
    double prev=99;for(NSNumber *n in f.times){assert(n.doubleValue>prev);prev=n.doubleValue;}
    // Mono 44.1 kHz microphone conversion into the same 48 kHz stereo writer input.
    f=input();mix=[[PPRecordingAudio alloc] initWithInput:(id)f epoch:CMTimeMake(100,1)];
    for(int i=0;i<10;i++){CMSampleBufferRef mic=sample(44100,1,4410,.25,100+i*.1);assert([mix append:mic at:CMTimeMakeWithSeconds(100+i*.1,48000) microphone:YES]);CFRelease(mic);}
    assert([mix flushThrough:CMTimeMake(101,1)]);assert(f.pcm.length>47000*2*sizeof(float));
    p=f.pcm.bytes;int nonzero=0;for(int i=0;i<f.pcm.length/sizeof(float);i++){assert(isfinite(p[i]) && fabs(p[i])<=1);if(fabs(p[i])>.01)nonzero++;}assert(nonzero>90000);
    // Clipping and writer back-pressure never cause unbounded allocation.
    f=input();mix=[[PPRecordingAudio alloc] initWithInput:(id)f epoch:CMTimeMake(100,1)];
    CMSampleBufferRef loud=sample(48000,2,4800,2,100);assert([mix append:loud at:CMTimeMake(100,1) microphone:YES]);CFRelease(loud);
    assert([mix flushThrough:CMTimeMakeWithSeconds(100.1,48000)]);p=f.pcm.bytes;for(int i=0;i<9600;i++)assert(p[i]==1);
    f=input();f.readyForMoreMediaData=NO;mix=[[PPRecordingAudio alloc] initWithInput:(id)f epoch:CMTimeMake(100,1)];
    BOOL overflow=NO;for(int i=0;i<30;i++){CMSampleBufferRef mic=sample(48000,2,4800,.3,100+i*.1);BOOL ok=[mix append:mic at:CMTimeMakeWithSeconds(100+i*.1,48000) microphone:YES];CFRelease(mic);if(!ok){overflow=YES;break;}}
    assert(overflow && f.pcm.length==0);
    puts("PASS: system+mic sum, monotonic timeline, mono 44.1k resampling, clipping, bounded writer back-pressure (no microphone opened)");
}}
