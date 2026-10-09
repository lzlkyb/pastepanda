#import "recording_audio.h"
#include <math.h>
// A bounded two-second timeline; 200 ms allows the two capture callbacks to arrive.
static const int64_t PPSampleRate=48000, PPCapacity=96000, PPWait=9600;
@interface PPRecordingAudio ()
@property AVAssetWriterInput *input;
@property AVAudioFormat *format;
@property AVAudioConverter *systemConverter;
@property AVAudioConverter *micConverter;
@property CMTime epoch;
@property int64_t cursor;
@property int64_t highWater;
@property NSMutableData *samples;
@end
@implementation PPRecordingAudio
- (instancetype)initWithInput:(AVAssetWriterInput *)input epoch:(CMTime)epoch {
    if((self=[super init])) {
        self.input=input; self.epoch=epoch;
        self.format=[[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:PPSampleRate channels:2 interleaved:YES];
        self.samples=[NSMutableData dataWithLength:PPCapacity*2*sizeof(float)];
    }
    return self;
}
- (BOOL)emitThrough:(int64_t)end {
    float *ring=self.samples.mutableBytes;
    while(self.cursor<end) {
        if(!self.input.readyForMoreMediaData) return YES;
        int64_t count=MIN(1024,end-self.cursor);
        float pcm[2048];
        for(int64_t i=0;i<count;i++) for(int c=0;c<2;c++) {
            int64_t at=((self.cursor+i)%PPCapacity)*2+c;
            pcm[i*2+c]=fmaxf(-1,fminf(1,ring[at])); ring[at]=0;
        }
        CMBlockBufferRef block=NULL; CMSampleBufferRef sample=NULL; CMAudioFormatDescriptionRef description=NULL;
        OSStatus code=CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault,NULL,count*2*sizeof(float),kCFAllocatorDefault,NULL,0,count*2*sizeof(float),0,&block);
        if(code==noErr) code=CMBlockBufferReplaceDataBytes(pcm,block,0,count*2*sizeof(float));
        if(code==noErr) code=CMAudioFormatDescriptionCreate(kCFAllocatorDefault,self.format.streamDescription,0,NULL,0,NULL,NULL,&description);
        if(code==noErr) code=CMAudioSampleBufferCreateReadyWithPacketDescriptions(kCFAllocatorDefault,block,description,count,CMTimeAdd(self.epoch,CMTimeMake(self.cursor,PPSampleRate)),NULL,&sample);
        BOOL ok=code==noErr && sample && [self.input appendSampleBuffer:sample];
        if(sample) CFRelease(sample); if(description) CFRelease(description); if(block) CFRelease(block);
        if(!ok) return NO;
        self.cursor+=count;
    }
    return YES;
}
- (BOOL)append:(CMSampleBufferRef)sample at:(CMTime)pts microphone:(BOOL)microphone {
    CMTime relative=CMTimeSubtract(pts,self.epoch);
    if(!CMTIME_IS_NUMERIC(relative)) return NO;
    double seconds=CMTimeGetSeconds(relative);
    if(!isfinite(seconds) || seconds< -2 || seconds>86400) return NO;
    AVAudioFormat *source=[[AVAudioFormat alloc] initWithCMAudioFormatDescription:CMSampleBufferGetFormatDescription(sample)];
    CMItemCount count=CMSampleBufferGetNumSamples(sample);
    if(!source || source.sampleRate<8000 || source.sampleRate>192000 || source.channelCount<1 || source.channelCount>8 || count<=0 || count>192000) return NO;
    AVAudioPCMBuffer *input=[[AVAudioPCMBuffer alloc] initWithPCMFormat:source frameCapacity:(AVAudioFrameCount)count];
    input.frameLength=(AVAudioFrameCount)count;
    if(!input || CMSampleBufferCopyPCMDataIntoAudioBufferList(sample,0,(int32_t)count,input.mutableAudioBufferList)!=noErr) return NO;
    AVAudioConverter *converter=microphone ? self.micConverter : self.systemConverter;
    if(!converter || ![converter.inputFormat isEqual:source]) {
        converter=[[AVAudioConverter alloc] initFromFormat:source toFormat:self.format];
        if(!converter) return NO;
        if(microphone) self.micConverter=converter; else self.systemConverter=converter;
    }
    AVAudioFrameCount capacity=(AVAudioFrameCount)ceil(count*PPSampleRate/source.sampleRate)+256;
    AVAudioPCMBuffer *output=[[AVAudioPCMBuffer alloc] initWithPCMFormat:self.format frameCapacity:capacity];
    __block AVAudioFrameCount offset=0; NSMutableData *converted=[NSMutableData new];
    // AVAudioConverter can return HaveData before consuming a complete callback.
    for(int attempt=0;attempt<128;attempt++) {
        NSError *error=nil;
        AVAudioConverterOutputStatus status=[converter convertToBuffer:output error:&error withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount packets,AVAudioConverterInputStatus *state){
            if(offset>=input.frameLength) { *state=AVAudioConverterInputStatus_NoDataNow; return nil; }
            AVAudioFrameCount take=MIN(packets,input.frameLength-offset);
            if(take==0) { *state=AVAudioConverterInputStatus_NoDataNow; return nil; }
            AVAudioPCMBuffer *chunk=[[AVAudioPCMBuffer alloc] initWithPCMFormat:source frameCapacity:take];
            chunk.frameLength=take;
            const AudioBufferList *from=input.audioBufferList; AudioBufferList *to=chunk.mutableAudioBufferList;
            size_t stride=source.streamDescription->mBytesPerFrame;
            for(UInt32 i=0;i<from->mNumberBuffers;i++) memcpy(to->mBuffers[i].mData,(uint8_t *)from->mBuffers[i].mData+offset*stride,take*stride);
            offset+=take; *state=AVAudioConverterInputStatus_HaveData; return chunk;
        }];
        if(error || status==AVAudioConverterOutputStatus_Error) return NO;
        [converted appendBytes:output.audioBufferList->mBuffers[0].mData length:output.frameLength*2*sizeof(float)];
        if(converted.length>capacity*2*sizeof(float)) return NO;
        if(status==AVAudioConverterOutputStatus_InputRanDry || status==AVAudioConverterOutputStatus_EndOfStream) break;
        if(output.frameLength==0 || attempt==127) return NO;
    }
    int64_t start=llround(seconds*PPSampleRate), end=start+converted.length/(2*sizeof(float));
    if(end-self.cursor>10*PPSampleRate) return NO;
    if(end<=self.cursor) return YES; // Late callbacks cannot modify already encoded audio.
    if(end-self.cursor>PPCapacity) {
        if(![self emitThrough:end-PPCapacity]) return NO;
        if(end-self.cursor>PPCapacity) return NO; // Writer stalled: never grow unbounded.
    }
    const float *pcm=converted.bytes;
    float *ring=self.samples.mutableBytes;
    for(int64_t i=MAX(self.cursor,start);i<end;i++) for(int c=0;c<2;c++) {
        float value=pcm[(i-start)*2+c];
        if(!isfinite(value)) return NO;
        ring[(i%PPCapacity)*2+c]+=value;
    }
    self.highWater=MAX(self.highWater,end);
    return [self emitThrough:MAX(self.cursor,self.highWater-PPWait)];
}
- (BOOL)flushThrough:(CMTime)end {
    double seconds=CMTimeGetSeconds(CMTimeSubtract(end,self.epoch));
    if(!isfinite(seconds) || seconds<0 || seconds>86400) return NO;
    int64_t target=MIN(self.highWater,llround(seconds*PPSampleRate));
    if(![self emitThrough:target]) return NO;
    return self.cursor>=target;
}
@end
