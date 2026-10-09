#import <Foundation/Foundation.h>
#import "../recording_frame.h"
#import <CoreVideo/CoreVideo.h>
#include <assert.h>
int main(){@autoreleasepool{
    uint8_t rgba[2*2*4]={9,19,29,255,39,49,59,255,69,79,89,255,99,109,119,255};
    CMTime at=CMTimeMake(12345,1000);CMSampleBufferRef sample=pp_recording_sample(rgba,sizeof(rgba),2,2,at);
    assert(sample && CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(sample),at)==0);
    CVPixelBufferRef pixels=CMSampleBufferGetImageBuffer(sample);assert(CVPixelBufferGetWidth(pixels)==2 && CVPixelBufferGetHeight(pixels)==2);
    CVPixelBufferLockBaseAddress(pixels,kCVPixelBufferLock_ReadOnly);
    uint8_t *data=CVPixelBufferGetBaseAddress(pixels);size_t stride=CVPixelBufferGetBytesPerRow(pixels);
    assert(data[0]==29 && data[1]==19 && data[2]==9 && data[3]==255);
    assert(data[stride+4]==119 && data[stride+5]==109 && data[stride+6]==99);
    CVPixelBufferUnlockBaseAddress(pixels,kCVPixelBufferLock_ReadOnly);CFRelease(sample);
    assert(!pp_recording_sample(rgba,1,2,2,at));assert(!pp_recording_sample(rgba,sizeof(rgba),UINT32_MAX,2,at));
    assert(!pp_recording_sample(rgba,sizeof(rgba),2,2,kCMTimeInvalid));
    puts("PASS: composite RGBA sample owns BGRA pixels, preserves host timestamp, rejects invalid dimensions (no screen capture)");return 0;
}}
