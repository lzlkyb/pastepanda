#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#include <stdint.h>
int32_t pp_rc_jpeg(const uint8_t *rgb,size_t length,uint32_t width,uint32_t height,uint8_t quality,uint8_t **output,size_t *bytes){
    if(!output || !bytes)return 1;*output=NULL;*bytes=0;
    uint64_t pixels=(uint64_t)width*height;
    if(!rgb || !width || !height || pixels>40000000 || length<pixels*3 || !quality || quality>100)return 1;
    @autoreleasepool {
        CGDataProviderRef provider=CGDataProviderCreateWithData(NULL,rgb,(size_t)pixels*3,NULL);CGColorSpaceRef space=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        CGImageRef image=provider && space ? CGImageCreate(width,height,8,24,(size_t)width*3,space,(CGBitmapInfo)kCGImageAlphaNone,provider,NULL,false,kCGRenderingIntentDefault) : NULL;
        if(space)CGColorSpaceRelease(space);if(provider)CGDataProviderRelease(provider);if(!image)return 2;
        NSMutableData *data=[NSMutableData new];CGImageDestinationRef destination=CGImageDestinationCreateWithData((__bridge CFMutableDataRef)data,CFSTR("public.jpeg"),1,NULL);
        BOOL success=NO;if(destination){CGImageDestinationAddImage(destination,image,(__bridge CFDictionaryRef)@{(__bridge id)kCGImageDestinationLossyCompressionQuality:@(quality/100.)});success=CGImageDestinationFinalize(destination);CFRelease(destination);}CGImageRelease(image);
        if(!success || !data.length || data.length>64*1024*1024)return 3;
        uint8_t *copy=malloc(data.length);if(!copy)return 4;memcpy(copy,data.bytes,data.length);*output=copy;*bytes=data.length;return 0;
    }
}
