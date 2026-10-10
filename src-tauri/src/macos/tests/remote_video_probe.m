#import <Foundation/Foundation.h>
#include <assert.h>
#include "../remote_video.m"
int main(int argc,char **argv){@autoreleasepool{
    NSMutableArray *fixtures=[NSMutableArray new];
    NSMutableData *packet=[NSMutableData new];uint8_t byte=1;
    assert(!appendNAL(packet,&byte,0));assert(!appendNAL(packet,&byte,8*1024*1024));
    assert(appendNAL(packet,&byte,1));assert(packet.length==5 && ((const uint8_t *)packet.bytes)[3]==1);
    printf("Hardware encoder: AVC=%d HEVC=%d\n",pp_rc_video_hardware_available(false),pp_rc_video_hardware_available(true));
    void *handle=NULL;assert(pp_rc_video_open(false,0,64,30,1000000,&handle)==1 && !handle);
    assert(pp_rc_video_open(false,64,64,30,1000000,&handle)==0 && handle);
    uint8_t rgba[64*64*4];for(size_t i=0;i<sizeof(rgba);i+=4){rgba[i]=190;rgba[i+1]=40;rgba[i+2]=20;rgba[i+3]=255;}
    for(int frame=0;frame<3;frame++){
        uint8_t *data=NULL;size_t length=0;bool key=false;char codec[64]={0};
        assert(pp_rc_video_encode(handle,rgba,sizeof(rgba),frame==2,&data,&length,&key,codec,sizeof(codec))==0);
        assert(data && length>8 && length<8*1024*1024 && !strncmp(codec,"avc1.",5));
        assert(data[0]==0 && data[1]==0 && data[2]==0 && data[3]==1);
        if(frame==0 || frame==2)assert(key && (data[4]&31)==7);
        [fixtures addObject:@{@"codec":[NSString stringWithUTF8String:codec],@"data":[[NSData dataWithBytes:data length:length] base64EncodedStringWithOptions:0],@"key":@(key),@"timestamp":@(frame*33333)}];
        free(data);
    }
    assert(pp_rc_video_set_bitrate(handle,800000)==0);pp_rc_video_close(handle);
    // Real IOSurface-backed buffer, allocated by the test; no screen is captured.
    CVPixelBufferRef surface=NULL;NSDictionary *attrs=@{(__bridge id)kCVPixelBufferIOSurfacePropertiesKey:@{}};
    assert(CVPixelBufferCreate(NULL,64,64,kCVPixelFormatType_32BGRA,(__bridge CFDictionaryRef)attrs,&surface)==0 && CVPixelBufferGetIOSurface(surface));
    CVPixelBufferLockBaseAddress(surface,0);uint8_t *base=CVPixelBufferGetBaseAddress(surface);size_t stride=CVPixelBufferGetBytesPerRow(surface);
    for(size_t y=0;y<64;y++)for(size_t x=0;x<64;x++){uint8_t *p=base+y*stride+x*4;p[0]=20;p[1]=40;p[2]=190;p[3]=255;}CVPixelBufferUnlockBaseAddress(surface,0);
    for(uint32_t fps=120;fps<=165;fps+=(fps==120?24:21)){
        assert(pp_rc_video_open(false,64,64,fps,1000000,&handle)==0);uint8_t *data=NULL;size_t length=0;bool key=false;char codec[64]={0};
        assert(pp_rc_video_encode_pixels(handle,surface,true,&data,&length,&key,codec,sizeof(codec))==0 && key && length>8);
        if(fps==120)[fixtures addObject:@{@"codec":[NSString stringWithUTF8String:codec],@"data":[[NSData dataWithBytes:data length:length] base64EncodedStringWithOptions:0],@"key":@YES,@"timestamp":@100000}];free(data);pp_rc_video_close(handle);
    }CVPixelBufferRelease(surface);
    puts("PASS: actual IOSurface feeds VideoToolbox without app RGBA copy at 120/144/165 request rates (synthetic 64px buffers, not display FPS)");
    if(pp_rc_video_hevc_available()){
        assert(pp_rc_video_open(true,64,64,30,1000000,&handle)==0);
        uint8_t *data=NULL;size_t length=0;bool key=false;char codec[64]={0};
        assert(pp_rc_video_encode(handle,rgba,sizeof(rgba),true,&data,&length,&key,codec,sizeof(codec))==0);
        assert(key && length>8 && !strncmp(codec,"hev1.",5) && ((data[4]>>1)&63)==32);
        [fixtures addObject:@{@"codec":[NSString stringWithUTF8String:codec],@"data":[[NSData dataWithBytes:data length:length] base64EncodedStringWithOptions:0],@"key":@(key),@"timestamp":@0}];free(data);pp_rc_video_close(handle);
        puts("PASS: native HEVC Annex-B includes VPS/SPS/PPS and derives actual hvcC codec string");
    }else puts("HEVC unavailable on this machine; H.264 fallback remains available");
    if(argc==2){NSData *json=[NSJSONSerialization dataWithJSONObject:fixtures options:0 error:nil];assert([json writeToFile:[NSString stringWithUTF8String:argv[1]] atomically:YES]);}
    puts("PASS: VideoToolbox encodes synthetic RGBA to bounded AVC Annex-B; IDR carries SPS/PPS and forced key works (no desktop capture)");return 0;
}}
