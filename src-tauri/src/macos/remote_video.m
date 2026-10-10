#import <Foundation/Foundation.h>
#import <VideoToolbox/VideoToolbox.h>
#import "recording_frame.h"
#import "remote_video.h"
#include <stdint.h>
@interface PPVideoEncoder:NSObject
@property VTCompressionSessionRef session;
@property NSMutableData *packet;
@property NSString *codec;
@property BOOL key;
@property int32_t failure;
@property uint32_t width,height,fps;
@property int64_t frame;
@property BOOL hevc;
@end
@implementation PPVideoEncoder
- (void)dealloc{if(_session){VTCompressionSessionInvalidate(_session);CFRelease(_session);}}
@end
static BOOL appendNAL(NSMutableData *packet,const uint8_t *bytes,size_t length){
    if(!bytes || !length || length>8*1024*1024-4 || packet.length>8*1024*1024-length-4)return NO;
    static const uint8_t prefix[]={0,0,0,1};[packet appendBytes:prefix length:4];[packet appendBytes:bytes length:length];return YES;
}
static void encoded(void *context,void *source,OSStatus status,VTEncodeInfoFlags flags,CMSampleBufferRef sample){
    PPVideoEncoder *state=(__bridge PPVideoEncoder *)context;
    @autoreleasepool{@synchronized(state){
        if(status || !sample || !CMSampleBufferDataIsReady(sample)){state.failure=4;return;}
        NSArray *attachments=(__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample,false);
        state.key=![attachments.firstObject[(__bridge id)kCMSampleAttachmentKey_NotSync] boolValue];
        NSMutableData *packet=[NSMutableData new];CMFormatDescriptionRef format=CMSampleBufferGetFormatDescription(sample);int header=0;
        const uint8_t *sps=NULL;size_t size=0,count=0;
        OSStatus params=state.hevc?CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(format,0,&sps,&size,&count,&header):CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format,0,&sps,&size,&count,&header);
        if(params!=noErr || !sps || size<4 || count>16 || header<1 || header>4){state.failure=4;return;}
        if(state.hevc){
            NSDictionary *atoms=(__bridge NSDictionary *)CMFormatDescriptionGetExtension(format,kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms);
            NSData *config=atoms[@"hvcC"];if(![config isKindOfClass:NSData.class] || config.length<23){state.failure=4;return;}
            const uint8_t *c=config.bytes;uint32_t compatibility=0;
            for(int i=0;i<32;i++)if(c[2+i/8]&(1<<(7-i%8)))compatibility|=1u<<i;
            NSString *space=(c[1]>>6)==0?@"":@[@"",@"A",@"B",@"C"][c[1]>>6];
            NSMutableString *constraints=[NSMutableString new];int last=11;while(last>6 && c[last]==0)last--;
            for(int i=6;i<=last;i++)[constraints appendFormat:i==6?@"%X":@".%X",c[i]];
            state.codec=[NSString stringWithFormat:@"hev1.%@%u.%X.%c%u.%@",space,c[1]&31,compatibility,c[1]&32?'H':'L',c[12],constraints];
        }else state.codec=[NSString stringWithFormat:@"avc1.%02x%02x%02x",sps[1],sps[2],sps[3]];
        if(state.key)for(size_t i=0;i<count;i++){
            const uint8_t *bytes=NULL;size_t length=0;
            OSStatus code=state.hevc?CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(format,i,&bytes,&length,NULL,NULL):CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format,i,&bytes,&length,NULL,NULL);
            if(code!=noErr || !appendNAL(packet,bytes,length)){state.failure=4;return;}
        }
        CMBlockBufferRef block=CMSampleBufferGetDataBuffer(sample);size_t total=block?CMBlockBufferGetDataLength(block):0;
        if(!total || total>8*1024*1024){state.failure=4;return;}
        // A compressed block buffer need not be contiguous.
        NSMutableData *raw=[NSMutableData dataWithLength:total];if(CMBlockBufferCopyDataBytes(block,0,total,raw.mutableBytes)!=noErr){state.failure=4;return;}
        const uint8_t *bytes=raw.bytes;size_t at=0,nals=0;
        while(at<total){
            if(total-at<(size_t)header || ++nals>1024){state.failure=4;return;}
            uint32_t length=0;for(int i=0;i<header;i++)length=(length<<8)|bytes[at++];
            if(length>total-at || !appendNAL(packet,bytes+at,length)){state.failure=4;return;}at+=length;
        }
        if(state.packet){state.failure=4;return;}state.packet=packet;
    }}
}
int32_t pp_rc_video_open(bool hevc,uint32_t width,uint32_t height,uint32_t fps,uint32_t bitrate,void **output){@autoreleasepool{
    if(!output)return 1;*output=NULL;if(!width || !height || width%2 || height%2 || width>8388608/height || fps<1 || fps>165 || bitrate<100000 || bitrate>100000000)return 1;
    PPVideoEncoder *state=[PPVideoEncoder new];state.width=width;state.height=height;state.fps=fps;state.hevc=hevc;
    VTCompressionSessionRef session=NULL;
    NSDictionary *spec=@{(__bridge id)kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder:@YES};
    OSStatus status=VTCompressionSessionCreate(NULL,width,height,hevc?kCMVideoCodecType_HEVC:kCMVideoCodecType_H264,(__bridge CFDictionaryRef)spec,NULL,NULL,encoded,(__bridge void *)state,&session);
    if(status || !session)return 4;state.session=session;
    NSDictionary *properties=@{(__bridge id)kVTCompressionPropertyKey_RealTime:@YES,(__bridge id)kVTCompressionPropertyKey_AllowFrameReordering:@NO,
        (__bridge id)kVTCompressionPropertyKey_ProfileLevel:hevc?(__bridge id)kVTProfileLevel_HEVC_Main_AutoLevel:(__bridge id)kVTProfileLevel_H264_High_AutoLevel,
        (__bridge id)kVTCompressionPropertyKey_AverageBitRate:@(bitrate),(__bridge id)kVTCompressionPropertyKey_ExpectedFrameRate:@(fps),
        (__bridge id)kVTCompressionPropertyKey_MaxKeyFrameInterval:@(fps*2)};
    if(VTSessionSetProperties(session,(__bridge CFDictionaryRef)properties)!=noErr || VTCompressionSessionPrepareToEncodeFrames(session)!=noErr)return 4;
    *output=(__bridge_retained void *)state;return 0;
}}
static int32_t encodePixels(PPVideoEncoder *state,CVPixelBufferRef pixels,bool key,uint8_t **output,size_t *outLength,bool *outKey,char *codec,size_t capacity){
    if(!pixels || CVPixelBufferGetWidth(pixels)!=state.width || CVPixelBufferGetHeight(pixels)!=state.height)return 1;
    state.packet=nil;state.failure=0;
    NSDictionary *options=key?@{(__bridge id)kVTEncodeFrameOptionKey_ForceKeyFrame:@YES}:nil;
    CMTime at=CMTimeMake(state.frame++,state.fps);
    OSStatus status=VTCompressionSessionEncodeFrame(state.session,pixels,at,CMTimeMake(1,state.fps),(__bridge CFDictionaryRef)options,NULL,NULL);
    if(status || VTCompressionSessionCompleteFrames(state.session,kCMTimeInvalid)!=noErr)return 4;
    @synchronized(state){
        if(state.failure || !state.packet.length || !state.codec)return 4;
        uint8_t *copy=malloc(state.packet.length);if(!copy)return 4;memcpy(copy,state.packet.bytes,state.packet.length);
        *output=copy;*outLength=state.packet.length;*outKey=state.key;strlcpy(codec,state.codec.UTF8String,capacity);state.packet=nil;return 0;
    }
}
int32_t pp_rc_video_encode(void *handle,const uint8_t *rgba,size_t length,bool key,uint8_t **output,size_t *outLength,bool *outKey,char *codec,size_t capacity){@autoreleasepool{
    if(!handle || !output || !outLength || !outKey || !codec || capacity<64)return 1;*output=NULL;*outLength=0;
    PPVideoEncoder *state=(__bridge PPVideoEncoder *)handle;
    CMSampleBufferRef sample=pp_recording_sample(rgba,length,state.width,state.height,kCMTimeZero);if(!sample)return 1;
    int32_t code=encodePixels(state,CMSampleBufferGetImageBuffer(sample),key,output,outLength,outKey,codec,capacity);CFRelease(sample);return code;
}}
int32_t pp_rc_video_encode_pixels(void *handle,CVPixelBufferRef pixels,bool key,uint8_t **output,size_t *outLength,bool *outKey,char *codec,size_t capacity){@autoreleasepool{
    if(!handle || !pixels || !output || !outLength || !outKey || !codec || capacity<64)return 1;*output=NULL;*outLength=0;
    // Reject the direct path unless SCK supplied a shareable surface. No app-side
    // pixel lock, CPU resize or RGBA copy occurs here; VT may perform conversion.
    if(!CVPixelBufferGetIOSurface(pixels))return 9;
    return encodePixels((__bridge PPVideoEncoder *)handle,pixels,key,output,outLength,outKey,codec,capacity);
}}
void pp_rc_video_close(void *handle){if(handle){PPVideoEncoder *state=(__bridge_transfer PPVideoEncoder *)handle;(void)state;}}

int32_t pp_rc_video_set_bitrate(void *handle,uint32_t bitrate){@autoreleasepool{
    if(!handle || bitrate<100000 || bitrate>100000000)return 1;
    PPVideoEncoder *state=(__bridge PPVideoEncoder *)handle;
    return VTSessionSetProperty(state.session,kVTCompressionPropertyKey_AverageBitRate,(__bridge CFNumberRef)@(bitrate))==noErr?0:4;
}}
int32_t pp_rc_video_hevc_available(void){@autoreleasepool{
    void *handle=NULL;int32_t code=pp_rc_video_open(true,64,64,30,1000000,&handle);if(handle)pp_rc_video_close(handle);return code==0;
}}

int32_t pp_rc_video_hardware_available(bool hevc){@autoreleasepool{
    void *handle=NULL;if(pp_rc_video_open(hevc,64,64,30,1000000,&handle)!=0 || !handle)return 0;
    PPVideoEncoder *state=(__bridge PPVideoEncoder *)handle;CFTypeRef value=NULL;
    OSStatus status=VTSessionCopyProperty(state.session,kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,NULL,&value);
    bool available=status==noErr && value && CFGetTypeID(value)==CFBooleanGetTypeID() && CFBooleanGetValue(value);
    if(value)CFRelease(value);pp_rc_video_close(handle);return available;
}}
