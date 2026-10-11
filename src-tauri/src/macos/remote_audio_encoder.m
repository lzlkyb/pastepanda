#import "remote_audio_encoder.h"
@interface PPRemoteAudioEncoder ()
@property AVAudioConverter *converter;
@property NSMutableArray<NSData *> *packets;
@property NSMutableArray<NSNumber *> *times;
@property CMTime epoch;
@property uint64_t emitted;
@end
@implementation PPRemoteAudioEncoder
- (instancetype)init {
    if((self=[super init])){self.packets=[NSMutableArray new];self.times=[NSMutableArray new];self.epoch=kCMTimeInvalid;}
    return self;
}
- (BOOL)append:(CMSampleBufferRef)sample {
    if(!sample || !CMSampleBufferDataIsReady(sample))return NO;
    AVAudioFormat *source=[[AVAudioFormat alloc] initWithCMAudioFormatDescription:CMSampleBufferGetFormatDescription(sample)];
    CMItemCount count=CMSampleBufferGetNumSamples(sample);
    // SCStream is configured to this wire format. Reject unexpected changes rather than mislabel AAC.
    if(!source || source.sampleRate!=48000 || source.channelCount!=2 || count<=0 || count>48000)return NO;
    CMTime pts=CMSampleBufferGetPresentationTimeStamp(sample);
    if(!CMTIME_IS_NUMERIC(pts))return NO;
    if(!CMTIME_IS_NUMERIC(self.epoch))self.epoch=pts;
    if(!self.converter){
        AVAudioFormat *target=[[AVAudioFormat alloc] initWithSettings:@{AVFormatIDKey:@(kAudioFormatMPEG4AAC),AVSampleRateKey:@48000,AVNumberOfChannelsKey:@2}];
        self.converter=[[AVAudioConverter alloc] initFromFormat:source toFormat:target];
        if(!self.converter)return NO;
        self.converter.bitRate=128000;
    }
    if(![self.converter.inputFormat isEqual:source])return NO;
    AVAudioPCMBuffer *input=[[AVAudioPCMBuffer alloc] initWithPCMFormat:source frameCapacity:(AVAudioFrameCount)count];
    if(!input)return NO;input.frameLength=(AVAudioFrameCount)count;
    if(CMSampleBufferCopyPCMDataIntoAudioBufferList(sample,0,(int32_t)count,input.mutableAudioBufferList)!=noErr)return NO;
    NSInteger maximum=self.converter.maximumOutputPacketSize;
    if(maximum<=0 || maximum>65536)return NO;
    AVAudioCompressedBuffer *output=[[AVAudioCompressedBuffer alloc] initWithFormat:self.converter.outputFormat packetCapacity:32 maximumPacketSize:maximum];
    if(!output)return NO;
    __block AVAudioFrameCount offset=0;
    for(int attempt=0;attempt<128;attempt++){
        NSError *error=nil;
        AVAudioConverterOutputStatus status=[self.converter convertToBuffer:output error:&error withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount requested,AVAudioConverterInputStatus *state){
            AVAudioFrameCount take=MIN(requested,input.frameLength-offset);
            if(!take){*state=AVAudioConverterInputStatus_NoDataNow;return nil;}
            AVAudioPCMBuffer *chunk=[[AVAudioPCMBuffer alloc] initWithPCMFormat:source frameCapacity:take];
            if(!chunk){*state=AVAudioConverterInputStatus_NoDataNow;return nil;}chunk.frameLength=take;
            const AudioBufferList *from=input.audioBufferList;AudioBufferList *to=chunk.mutableAudioBufferList;size_t stride=source.streamDescription->mBytesPerFrame;
            for(UInt32 i=0;i<from->mNumberBuffers;i++)memcpy(to->mBuffers[i].mData,(uint8_t *)from->mBuffers[i].mData+offset*stride,take*stride);
            offset+=take;*state=AVAudioConverterInputStatus_HaveData;return chunk;
        }];
        if(error || status==AVAudioConverterOutputStatus_Error || output.packetCount>32)return NO;
        for(UInt32 i=0;i<output.packetCount;i++){
            AudioStreamPacketDescription description=output.packetDescriptions[i];
            if(description.mStartOffset<0 || description.mDataByteSize==0 || (uint64_t)description.mStartOffset+description.mDataByteSize>output.byteLength)return NO;
            if(self.packets.count>=64){[self.packets removeObjectAtIndex:0];[self.times removeObjectAtIndex:0];}
            [self.packets addObject:[NSData dataWithBytes:(uint8_t *)output.data+description.mStartOffset length:description.mDataByteSize]];
            [self.times addObject:@(self.emitted*1024*1000/48000)];self.emitted++;
        }
        if(status==AVAudioConverterOutputStatus_InputRanDry || status==AVAudioConverterOutputStatus_EndOfStream)return YES;
        if(!output.packetCount || attempt==127)return NO;
    }
    return NO;
}
@end
