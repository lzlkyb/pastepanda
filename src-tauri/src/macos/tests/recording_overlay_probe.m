#import "../recording_overlay.h"
#include <assert.h>
int main(){@autoreleasepool {
    CVPixelBufferRef pixels=NULL;assert(CVPixelBufferCreate(NULL,64,64,kCVPixelFormatType_32BGRA,NULL,&pixels)==0);
    CVPixelBufferLockBaseAddress(pixels,0);memset(CVPixelBufferGetBaseAddress(pixels),0,CVPixelBufferGetBytesPerRow(pixels)*64);CVPixelBufferUnlockBaseAddress(pixels,0);
    CMVideoFormatDescriptionRef format=NULL;assert(CMVideoFormatDescriptionCreateForImageBuffer(NULL,pixels,&format)==0);
    CMSampleTimingInfo timing={CMTimeMake(1,30),CMTimeMake(10,1),kCMTimeInvalid};CMSampleBufferRef source=NULL;
    assert(CMSampleBufferCreateReadyWithImageBuffer(NULL,pixels,format,&timing,&source)==0);
    PPClickPainter *painter=[PPClickPainter new];
    CMSampleBufferRef painted=[painter copySample:source x:32 y:32 radius:12 age:0];assert(painted);
    assert(CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(painted),timing.presentationTimeStamp)==0);
    CVPixelBufferRef output=CMSampleBufferGetImageBuffer(painted);
    CVPixelBufferLockBaseAddress(output,kCVPixelBufferLock_ReadOnly);CVPixelBufferLockBaseAddress(pixels,kCVPixelBufferLock_ReadOnly);
    uint8_t *dest=CVPixelBufferGetBaseAddress(output),*original=CVPixelBufferGetBaseAddress(pixels);
    assert(dest[32*CVPixelBufferGetBytesPerRow(output)+32*4+2]>0);
    for(size_t i=0;i<CVPixelBufferGetBytesPerRow(pixels)*64;i++) assert(original[i]==0);
    CVPixelBufferUnlockBaseAddress(output,kCVPixelBufferLock_ReadOnly);CVPixelBufferUnlockBaseAddress(pixels,kCVPixelBufferLock_ReadOnly);
    assert(![painter copySample:source x:32 y:32 radius:12 age:1]);
    assert(![painter copySample:source x:NAN y:32 radius:12 age:0]);
    CMSampleBufferRef held[3];for(int i=0;i<3;i++){held[i]=[painter copySample:source x:32 y:32 radius:12 age:0];assert(held[i]);}
    assert(![painter copySample:source x:32 y:32 radius:12 age:0] && painter.backpressured);
    for(int i=0;i<3;i++) CFRelease(held[i]);
    CMSampleBufferRef recovered=[painter copySample:source x:32 y:32 radius:12 age:0];assert(recovered && !painter.backpressured);CFRelease(recovered);
    CFRelease(painted);CFRelease(source);CFRelease(format);CVPixelBufferRelease(pixels);
    puts("PASS: highlight changes owned pixels, preserves source pixels and timestamp, rejects expired/invalid clicks");
}return 0;}
