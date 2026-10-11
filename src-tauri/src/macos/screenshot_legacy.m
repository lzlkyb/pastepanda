#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreVideo/CoreVideo.h>
#include <stdint.h>
extern double pp_mac_screen_scale(void);
static void releasePixels(void *info,const void *bytes,size_t length){free((void *)bytes);}
static NSData *snapshotPNG(CVPixelBufferRef pixels){
    if(!pixels || CVPixelBufferGetPixelFormatType(pixels)!=kCVPixelFormatType_32BGRA)return nil;
    size_t w=CVPixelBufferGetWidth(pixels),h=CVPixelBufferGetHeight(pixels);
    if(!w || !h || w>67108864/h)return nil;
    if(CVPixelBufferLockBaseAddress(pixels,kCVPixelBufferLock_ReadOnly)!=kCVReturnSuccess)return nil;
    const uint8_t *base=CVPixelBufferGetBaseAddress(pixels);size_t stride=CVPixelBufferGetBytesPerRow(pixels);
    uint8_t *copy=(base && stride>=w*4)?malloc(w*h*4):NULL;
    if(copy)for(size_t y=0;y<h;y++)memcpy(copy+y*w*4,base+y*stride,w*4);
    CVPixelBufferUnlockBaseAddress(pixels,kCVPixelBufferLock_ReadOnly);if(!copy)return nil;
    CGDataProviderRef provider=CGDataProviderCreateWithData(NULL,copy,w*h*4,releasePixels);
    if(!provider){free(copy);return nil;}
    CGColorSpaceRef colors=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef image=CGImageCreate(w,h,8,32,w*4,colors,kCGBitmapByteOrder32Little|kCGImageAlphaPremultipliedFirst,provider,NULL,false,kCGRenderingIntentDefault);
    NSData *png=nil;if(image){NSBitmapImageRep *bitmap=[[NSBitmapImageRep alloc] initWithCGImage:image];png=[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];CGImageRelease(image);}
    CGColorSpaceRelease(colors);CGDataProviderRelease(provider);return png;
}
API_AVAILABLE(macos(12.3))
@interface PPLegacyShot:NSObject <SCStreamOutput,SCStreamDelegate>
@property dispatch_queue_t queue;
@property dispatch_semaphore_t done;
@property SCStream *stream;
@property NSData *png;
@property BOOL stopped;
@property BOOL starting;
@property int32_t status;
@end
@implementation PPLegacyShot
- (void)finish:(int32_t)code {
    if(self.stopped)return;self.stopped=YES;self.status=code;dispatch_semaphore_signal(self.done);
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {dispatch_async(self.queue,^{[self finish:3];});}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if(self.stopped || type!=SCStreamOutputTypeScreen || !CMSampleBufferDataIsReady(sample))return;
    NSArray *attachments=(__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample,false);
    NSNumber *status=attachments.firstObject[SCStreamFrameInfoStatus];if(!status || status.integerValue!=SCFrameStatusComplete)return;
    self.png=snapshotPNG(CMSampleBufferGetImageBuffer(sample));[self finish:self.png?0:3];
}
@end
static void stopLegacy(PPLegacyShot *state) API_AVAILABLE(macos(12.3));
static void stopLegacy(PPLegacyShot *state){
    dispatch_async(state.queue,^{
        state.stopped=YES;if(!state.stream)return;
        NSError *ignored=nil;[state.stream removeStreamOutput:state type:SCStreamOutputTypeScreen error:&ignored];
        if(state.starting)return;
        [state.stream stopCaptureWithCompletionHandler:^(NSError *error){dispatch_async(state.queue,^{state.stream=nil;});}];
    });
}
int32_t pp_mac_capture_legacy(uint32_t displayID,uint32_t width,uint32_t height,uint8_t **output,size_t *length){
    if(!output || !length)return 1;*output=NULL;*length=0;
    if(NSThread.isMainThread)return 7;if(!CGPreflightScreenCaptureAccess())return 2;
    if(@available(macOS 12.3,*)){
        PPLegacyShot *state=[PPLegacyShot new];state.queue=dispatch_queue_create("pastepanda.snapshot.legacy",DISPATCH_QUEUE_SERIAL);state.done=dispatch_semaphore_create(0);state.status=3;
        [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent *content,NSError *error){
            dispatch_async(state.queue,^{
                if(state.stopped)return;if(error || !content){[state finish:3];return;}
                SCDisplay *display=nil;for(SCDisplay *candidate in content.displays)if(candidate.displayID==displayID)display=candidate;
                if(!display){[state finish:3];return;}
                NSMutableArray *excluded=[NSMutableArray new];for(SCRunningApplication *app in content.applications)if(app.processID==getpid())[excluded addObject:app];
                SCContentFilter *filter=[[SCContentFilter alloc] initWithDisplay:display excludingApplications:excluded exceptingWindows:@[]];
                SCStreamConfiguration *config=[SCStreamConfiguration new];config.width=width;config.height=height;
                if(!config.width || !config.height || config.width>67108864/config.height){[state finish:6];return;}
                config.pixelFormat=kCVPixelFormatType_32BGRA;config.colorSpaceName=kCGColorSpaceSRGB;config.queueDepth=3;config.minimumFrameInterval=CMTimeMake(1,30);config.showsCursor=NO;
                state.stream=[[SCStream alloc] initWithFilter:filter configuration:config delegate:state];NSError *failure=nil;
                if(![state.stream addStreamOutput:state type:SCStreamOutputTypeScreen sampleHandlerQueue:state.queue error:&failure]){[state finish:3];return;}
                state.starting=YES;
                [state.stream startCaptureWithCompletionHandler:^(NSError *error){dispatch_async(state.queue,^{state.starting=NO;if(error)[state finish:3];if(state.stopped)stopLegacy(state);});}];
            });
        }];
        long timedOut=dispatch_semaphore_wait(state.done,dispatch_time(DISPATCH_TIME_NOW,8*NSEC_PER_SEC));stopLegacy(state);
        if(timedOut)return 4;if(state.status)return state.status;
        if(!state.png.length || state.png.length>256*1024*1024)return 6;
        uint8_t *bytes=malloc(state.png.length);if(!bytes)return 5;memcpy(bytes,state.png.bytes,state.png.length);*output=bytes;*length=state.png.length;return 0;
    }return 8;
}
