#import "recording_overlay.h"
#import <CoreGraphics/CoreGraphics.h>
@implementation PPClickPainter { CVPixelBufferPoolRef _pool; size_t _width,_height; BOOL _backpressured; }
- (BOOL)backpressured {return _backpressured;}
- (void)dealloc { if(_pool) CVPixelBufferPoolRelease(_pool); }
- (CMSampleBufferRef)copySample:(CMSampleBufferRef)sample x:(double)x y:(double)y radius:(double)radius age:(double)age {
    _backpressured=NO;
    CVPixelBufferRef source=CMSampleBufferGetImageBuffer(sample);
    if(!source || CVPixelBufferGetPixelFormatType(source)!=kCVPixelFormatType_32BGRA || !isfinite(x+y+radius+age) || radius<=0 || age<0 || age>.45) return NULL;
    size_t w=CVPixelBufferGetWidth(source),h=CVPixelBufferGetHeight(source);
    if(!w || !h || w*h>40000000) return NULL;
    if(!_pool || _width!=w || _height!=h) {
        if(_pool) { CVPixelBufferPoolRelease(_pool);_pool=NULL; }
        NSDictionary *attrs=@{(id)kCVPixelBufferWidthKey:@(w),(id)kCVPixelBufferHeightKey:@(h),(id)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_32BGRA)};
        if(CVPixelBufferPoolCreate(NULL,NULL,(__bridge CFDictionaryRef)attrs,&_pool)!=kCVReturnSuccess) return NULL;
        _width=w;_height=h;
    }
    CVPixelBufferRef pixels=NULL;
    NSDictionary *limit=@{(id)kCVPixelBufferPoolAllocationThresholdKey:@4};
    CVReturn allocation=CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(NULL,_pool,(__bridge CFDictionaryRef)limit,&pixels);
    if(allocation!=kCVReturnSuccess) {_backpressured=allocation==kCVReturnWouldExceedAllocationThreshold;return NULL;}
    if(CVPixelBufferLockBaseAddress(source,kCVPixelBufferLock_ReadOnly)!=kCVReturnSuccess) { CVPixelBufferRelease(pixels);return NULL; }
    if(CVPixelBufferLockBaseAddress(pixels,0)!=kCVReturnSuccess) { CVPixelBufferUnlockBaseAddress(source,kCVPixelBufferLock_ReadOnly);CVPixelBufferRelease(pixels);return NULL; }
    for(size_t row=0;row<h;row++) memcpy((uint8_t *)CVPixelBufferGetBaseAddress(pixels)+row*CVPixelBufferGetBytesPerRow(pixels),(uint8_t *)CVPixelBufferGetBaseAddress(source)+row*CVPixelBufferGetBytesPerRow(source),w*4);
    CGColorSpaceRef color=CGColorSpaceCreateDeviceRGB();
    CGContextRef context=CGBitmapContextCreate(CVPixelBufferGetBaseAddress(pixels),w,h,8,CVPixelBufferGetBytesPerRow(pixels),color,kCGBitmapByteOrder32Little|kCGImageAlphaPremultipliedFirst);
    CGColorSpaceRelease(color);
    if(context) {
        CGContextTranslateCTM(context,0,h);CGContextScaleCTM(context,1,-1);
        double alpha=1-age/.45;CGRect circle=CGRectMake(x-radius,y-radius,radius*2,radius*2);
        CGContextSetRGBFillColor(context,1,.72,0,.3*alpha);CGContextFillEllipseInRect(context,circle);
        CGContextSetRGBStrokeColor(context,1,.72,0,.85*alpha);CGContextSetLineWidth(context,MAX(1,radius/8));CGContextStrokeEllipseInRect(context,circle);CGContextRelease(context);
    }
    CVPixelBufferUnlockBaseAddress(pixels,0);CVPixelBufferUnlockBaseAddress(source,kCVPixelBufferLock_ReadOnly);
    CVBufferPropagateAttachments(source,pixels);
    CMVideoFormatDescriptionRef format=NULL;CMSampleBufferRef result=NULL;CMSampleTimingInfo timing;
    if(context && CMVideoFormatDescriptionCreateForImageBuffer(NULL,pixels,&format)==noErr && CMSampleBufferGetSampleTimingInfo(sample,0,&timing)==noErr)
        CMSampleBufferCreateReadyWithImageBuffer(NULL,pixels,format,&timing,&result);
    if(format) CFRelease(format);CVPixelBufferRelease(pixels);return result;
}
@end
