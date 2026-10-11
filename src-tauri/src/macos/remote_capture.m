#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreVideo/CoreVideo.h>
#include <stdint.h>
#import "remote_video.h"
API_AVAILABLE(macos(12.3))
@interface PPRemoteCapture : NSObject <SCStreamOutput,SCStreamDelegate>
@property dispatch_queue_t queue;
@property SCStream *stream;
@property CVPixelBufferRef latest;
@property BOOL stopped;
@property BOOL starting;
@property int32_t failure;
@property dispatch_semaphore_t first;
@property uint64_t sequence,lastEncoded;
@end
@implementation PPRemoteCapture
- (void)dealloc {if(self.latest) CVPixelBufferRelease(self.latest);}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {dispatch_async(self.queue, ^{self.failure=4;self.stopped=YES;dispatch_semaphore_signal(self.first);});}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if(self.stopped || type!=SCStreamOutputTypeScreen || !CMSampleBufferDataIsReady(sample))return;
    NSArray *attachments=(__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample,false);
    NSNumber *status=attachments.firstObject[SCStreamFrameInfoStatus];if(status.integerValue!=SCFrameStatusComplete || !status)return;
    CVPixelBufferRef pixels=CMSampleBufferGetImageBuffer(sample);if(!pixels || CVPixelBufferGetPixelFormatType(pixels)!=kCVPixelFormatType_32BGRA)return;
    BOOL first=!self.latest;CVPixelBufferRetain(pixels);if(self.latest)CVPixelBufferRelease(self.latest);self.latest=pixels;self.sequence++;
    if(first)dispatch_semaphore_signal(self.first);
}
@end
static void onMain(void (^work)(void)){if(NSThread.isMainThread)work();else dispatch_sync(dispatch_get_main_queue(),work);}
int32_t pp_rc_host_ready(void){
    if(@available(macOS 12.3,*)) {
        if(!NSApp)return 9;
        if(!CGPreflightScreenCaptureAccess())return 2;
        return 0;
    }return 8;
}
void pp_rc_capture_stop(void *handle){
    if(@available(macOS 12.3,*)) {if(!handle)return;PPRemoteCapture *state=(__bridge_transfer PPRemoteCapture *)handle;
        dispatch_async(state.queue, ^{state.stopped=YES;if(state.starting)return;[state.stream stopCaptureWithCompletionHandler:^(NSError *error){state.stream=nil;}];});
    }
}
int32_t pp_rc_capture_start(uint32_t displayID,uint32_t width,uint32_t height,uint32_t fps,uint32_t timeoutMS,bool excludeOwn,void **output){
    if(!output)return 1;*output=NULL;if(fps<1 || fps>165 || !timeoutMS || timeoutMS>8000)return 1;if(NSThread.isMainThread)return 7;
    int32_t readiness=pp_rc_host_ready();if(readiness)return readiness;
    if(@available(macOS 12.3,*)) {@autoreleasepool {
        PPRemoteCapture *state=[PPRemoteCapture new];state.queue=dispatch_queue_create("pastepanda.remote.capture",DISPATCH_QUEUE_SERIAL);state.first=dispatch_semaphore_create(0);
        dispatch_semaphore_t ready=dispatch_semaphore_create(0);__block int32_t code=4;
        [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent *content,NSError *error){
            dispatch_async(state.queue, ^{
                if(error || !content || state.stopped){dispatch_semaphore_signal(ready);return;}
                SCDisplay *display=nil;for(SCDisplay *candidate in content.displays)if(candidate.displayID==displayID)display=candidate;
                if(!display){dispatch_semaphore_signal(ready);return;}
                SCStreamConfiguration *config=[SCStreamConfiguration new];config.width=width;config.height=height;
                if(!config.width || !config.height || config.width>40000000/config.height){dispatch_semaphore_signal(ready);return;}
                config.pixelFormat=kCVPixelFormatType_32BGRA;config.colorSpaceName=kCGColorSpaceSRGB;config.queueDepth=3;config.showsCursor=YES;config.minimumFrameInterval=CMTimeMake(1,fps);
                // A remote viewing session shares the desktop, including this application's main UI.
                NSMutableArray *excluded=[NSMutableArray new];if(excludeOwn)for(SCRunningApplication *app in content.applications)if(app.processID==getpid())[excluded addObject:app];
                SCContentFilter *filter=[[SCContentFilter alloc] initWithDisplay:display excludingApplications:excluded exceptingWindows:@[]];
                state.stream=[[SCStream alloc] initWithFilter:filter configuration:config delegate:state];
                NSError *outputError=nil;if(![state.stream addStreamOutput:state type:SCStreamOutputTypeScreen sampleHandlerQueue:state.queue error:&outputError]){dispatch_semaphore_signal(ready);return;}
                state.starting=YES;
                [state.stream startCaptureWithCompletionHandler:^(NSError *error){dispatch_async(state.queue, ^{
                    state.starting=NO;code=(error || state.stopped) ? 4 : 0;
                    if(state.stopped)[state.stream stopCaptureWithCompletionHandler:^(NSError *stopError){state.stream=nil;}];
                    dispatch_semaphore_signal(ready);
                });}];
            });
        }];
        dispatch_time_t deadline=dispatch_time(DISPATCH_TIME_NOW,(int64_t)timeoutMS*NSEC_PER_MSEC);
        if(dispatch_semaphore_wait(ready,deadline)!=0 || code || dispatch_semaphore_wait(state.first,deadline)!=0 || state.failure){
            void *owned=(__bridge_retained void *)state;pp_rc_capture_stop(owned);return 4;
        }
        *output=(__bridge_retained void *)state;return 0;
    }}return 8;
}
int32_t pp_rc_capture_frame(void *handle,uint8_t **output,size_t *length,uint32_t *width,uint32_t *height){
    if(!handle || !output || !length || !width || !height)return 1;*output=NULL;*length=0;
    if(@available(macOS 12.3,*)) {@autoreleasepool {
        PPRemoteCapture *state=(__bridge PPRemoteCapture *)handle;__block int32_t code=4;
        dispatch_sync(state.queue, ^{
            CVPixelBufferRef pixels=state.latest;if(state.stopped || !pixels)return;
            size_t w=CVPixelBufferGetWidth(pixels),h=CVPixelBufferGetHeight(pixels);if(!w || !h || w>40000000/h)return;
            if(CVPixelBufferLockBaseAddress(pixels,kCVPixelBufferLock_ReadOnly)!=kCVReturnSuccess)return;
            uint8_t *rgba=malloc(w*h*4);const uint8_t *base=CVPixelBufferGetBaseAddress(pixels);size_t stride=CVPixelBufferGetBytesPerRow(pixels);
            if(rgba && base){for(size_t y=0;y<h;y++){const uint8_t *row=base+y*stride;uint8_t *dest=rgba+y*w*4;for(size_t x=0;x<w;x++){dest[x*4]=row[x*4+2];dest[x*4+1]=row[x*4+1];dest[x*4+2]=row[x*4];dest[x*4+3]=255;}}
                *output=rgba;*length=w*h*4;*width=(uint32_t)w;*height=(uint32_t)h;code=0;
            }else if(rgba)free(rgba);
            CVPixelBufferUnlockBaseAddress(pixels,kCVPixelBufferLock_ReadOnly);
        });return code;
    }}return 8;
}

int32_t pp_rc_capture_encode(void *handle,void *encoder,bool key,uint8_t **output,size_t *length,bool *outKey,char *codec,size_t capacity){
    if(!handle || !encoder || !output || !length)return 1;*output=NULL;*length=0;
    if(@available(macOS 12.3,*)){@autoreleasepool{
        PPRemoteCapture *state=(__bridge PPRemoteCapture *)handle;
        __block CVPixelBufferRef pixels=NULL;__block uint64_t sequence=0;__block int32_t code=4;
        dispatch_sync(state.queue,^{
            if(state.stopped || !state.latest)return;
            sequence=state.sequence;
            if(sequence==state.lastEncoded && !key){code=10;return;}
            pixels=CVPixelBufferRetain(state.latest);code=0;
        });if(code)return code;
        code=pp_rc_video_encode_pixels(encoder,pixels,key,output,length,outKey,codec,capacity);CVPixelBufferRelease(pixels);
        if(code==0)dispatch_sync(state.queue,^{state.lastEncoded=sequence;});return code;
    }}return 8;
}
