#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdint.h>
#include <stdbool.h>
@interface PPVideoFrames : NSObject
@property AVAssetImageGenerator *generator;
@property double duration;
@end
@implementation PPVideoFrames
@end
@interface PPVideoImage : NSObject
@property CGImageRef image;
@property int32_t status;
@end
@implementation PPVideoImage
- (void)dealloc {if(_image) CGImageRelease(_image);}
@end
void *pp_video_open(const char *path,double *duration,int32_t *status) {
    if(!path || !duration || !status) return NULL;
    *duration=0;*status=1;
    @autoreleasepool {
        NSString *file=[NSString stringWithUTF8String:path];
        if(!file || !file.isAbsolutePath || ![NSFileManager.defaultManager fileExistsAtPath:file]) return NULL;
        AVURLAsset *asset=[AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:file] options:nil];
        double seconds=CMTimeGetSeconds(asset.duration);
        if([asset tracksWithMediaType:AVMediaTypeVideo].count==0 || !isfinite(seconds) || seconds<=0 || seconds>86400) {*status=2;return NULL;}
        PPVideoFrames *frames=[PPVideoFrames new];frames.duration=seconds;
        frames.generator=[[AVAssetImageGenerator alloc]initWithAsset:asset];
        frames.generator.appliesPreferredTrackTransform=YES;
        frames.generator.maximumSize=CGSizeMake(480,4096);
        frames.generator.requestedTimeToleranceBefore=kCMTimeZero;
        frames.generator.requestedTimeToleranceAfter=kCMTimeZero;
        *duration=seconds;*status=0;return (__bridge_retained void *)frames;
    }
}
void pp_video_close(void *handle) {
    if(!handle)return;
    PPVideoFrames *frames=CFBridgingRelease(handle);
    [frames.generator cancelAllCGImageGeneration];
}
int32_t pp_video_frame(void *handle,double seconds,bool (*cancelled)(void *),void *context,
    uint8_t **output,size_t *length,uint32_t *width,uint32_t *height) {
    if(!handle || !cancelled || !output || !length || !width || !height || !isfinite(seconds) || seconds<0)return 1;
    *output=NULL;*length=0;*width=0;*height=0;
    @autoreleasepool {
        PPVideoFrames *frames=(__bridge PPVideoFrames *)handle;
        if(seconds>=frames.duration)return 2;
        PPVideoImage *result=[PPVideoImage new];result.status=5;
        dispatch_semaphore_t ready=dispatch_semaphore_create(0);
        [frames.generator generateCGImagesAsynchronouslyForTimes:@[[NSValue valueWithCMTime:CMTimeMakeWithSeconds(seconds,60000)]]
            completionHandler:^(CMTime requested,CGImageRef image,CMTime actual,AVAssetImageGeneratorResult outcome,NSError *error){
                if(outcome==AVAssetImageGeneratorSucceeded && image){result.image=CGImageRetain(image);result.status=0;}
                dispatch_semaphore_signal(ready);
            }];
        BOOL arrived=NO;
        for(int i=0;i<160;i++) {
            if(cancelled(context)){[frames.generator cancelAllCGImageGeneration];return 7;}
            if(dispatch_semaphore_wait(ready,dispatch_time(DISPATCH_TIME_NOW,50*NSEC_PER_MSEC))==0){arrived=YES;break;}
        }
        if(!arrived){[frames.generator cancelAllCGImageGeneration];return 8;}
        if(result.status)return result.status;
        size_t w=CGImageGetWidth(result.image),h=CGImageGetHeight(result.image);
        if(w==0 || h==0 || w>480 || h>4096)return 3;
        size_t bytes=w*h*4;
        uint8_t *rgba=calloc(1,bytes);if(!rgba)return 4;
        CGColorSpaceRef color=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        CGContextRef bitmap=CGBitmapContextCreate(rgba,w,h,8,w*4,color,kCGImageAlphaPremultipliedLast|kCGBitmapByteOrder32Big);
        if(color)CGColorSpaceRelease(color);
        if(!bitmap){free(rgba);return 4;}
        CGContextDrawImage(bitmap,CGRectMake(0,0,w,h),result.image);
        CGContextRelease(bitmap);
        *output=rgba;*length=bytes;*width=(uint32_t)w;*height=(uint32_t)h;return 0;
    }
}
