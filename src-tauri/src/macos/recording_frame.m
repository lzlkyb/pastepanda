#import "recording_frame.h"
#import <CoreVideo/CoreVideo.h>
CMSampleBufferRef pp_recording_sample(const uint8_t *rgba,size_t length,uint32_t width,uint32_t height,CMTime timestamp){
    if(!rgba || !width || !height || width>40000000/height || length!=(size_t)width*height*4 || !CMTIME_IS_NUMERIC(timestamp))return NULL;
    CVPixelBufferRef pixels=NULL;
    if(CVPixelBufferCreate(NULL,width,height,kCVPixelFormatType_32BGRA,NULL,&pixels)!=kCVReturnSuccess)return NULL;
    if(CVPixelBufferLockBaseAddress(pixels,0)!=kCVReturnSuccess){CVPixelBufferRelease(pixels);return NULL;}
    uint8_t *base=CVPixelBufferGetBaseAddress(pixels);size_t stride=CVPixelBufferGetBytesPerRow(pixels);
    if(!base || stride<(size_t)width*4){CVPixelBufferUnlockBaseAddress(pixels,0);CVPixelBufferRelease(pixels);return NULL;}
    for(size_t y=0;y<height;y++)for(size_t x=0;x<width;x++){
        const uint8_t *src=rgba+(y*width+x)*4;uint8_t *dst=base+y*stride+x*4;
        dst[0]=src[2];dst[1]=src[1];dst[2]=src[0];dst[3]=255;
    }
    CVPixelBufferUnlockBaseAddress(pixels,0);
    CMVideoFormatDescriptionRef format=NULL;CMSampleBufferRef sample=NULL;
    if(CMVideoFormatDescriptionCreateForImageBuffer(NULL,pixels,&format)==noErr){
        CMSampleTimingInfo timing={kCMTimeInvalid,timestamp,kCMTimeInvalid};
        CMSampleBufferCreateReadyWithImageBuffer(NULL,pixels,format,&timing,&sample);
        CFRelease(format);
    }
    CVPixelBufferRelease(pixels);return sample;
}
