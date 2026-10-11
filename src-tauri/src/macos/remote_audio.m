#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import "remote_audio_encoder.h"
#include <stdint.h>
extern int32_t pp_rc_host_ready(void);
API_AVAILABLE(macos(13.0))
@interface PPRemoteAudio : NSObject <SCStreamOutput,SCStreamDelegate>
@property dispatch_queue_t queue;
@property SCStream *stream;
@property PPRemoteAudioEncoder *encoder;
@property BOOL stopped;
@property BOOL starting;
@property int32_t failure;
@end
@implementation PPRemoteAudio
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    dispatch_async(self.queue, ^{if(!self.stopped)self.failure=4;});
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if(self.stopped || self.failure || type!=SCStreamOutputTypeAudio)return;
    if(![self.encoder append:sample])self.failure=5;
}
@end
void pp_rc_audio_stop(void *handle){
    if(@available(macOS 13.0,*)){
        if(!handle)return;PPRemoteAudio *state=(__bridge_transfer PPRemoteAudio *)handle;
        dispatch_semaphore_t done=dispatch_semaphore_create(0);
        dispatch_sync(state.queue, ^{
            state.stopped=YES;
            [state.encoder.packets removeAllObjects];[state.encoder.times removeAllObjects];
            if(!state.stream){dispatch_semaphore_signal(done);return;}
            SCStream *stream=state.stream;NSError *ignored=nil;
            [stream removeStreamOutput:state type:SCStreamOutputTypeAudio error:&ignored];
            if(state.starting){dispatch_semaphore_signal(done);return;}
            [stream stopCaptureWithCompletionHandler:^(NSError *error){dispatch_async(state.queue,^{state.stream=nil;dispatch_semaphore_signal(done);});}];
        });
        dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_SEC));
    }
}
int32_t pp_rc_audio_start(void **output){
    if(!output)return 1;*output=NULL;if(NSThread.isMainThread)return 7;
    int32_t readiness=pp_rc_host_ready();if(readiness)return readiness;
    if(@available(macOS 13.0,*)){
        PPRemoteAudio *state=[PPRemoteAudio new];state.queue=dispatch_queue_create("pastepanda.remote.audio",DISPATCH_QUEUE_SERIAL);state.encoder=[PPRemoteAudioEncoder new];
        dispatch_semaphore_t ready=dispatch_semaphore_create(0);__block int32_t code=4;
        [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent *content,NSError *error){
            dispatch_async(state.queue, ^{
                if(error || content.displays.count!=1 || state.stopped){dispatch_semaphore_signal(ready);return;}
                SCStreamConfiguration *config=[SCStreamConfiguration new];config.width=16;config.height=16;config.minimumFrameInterval=CMTimeMake(1,1);config.queueDepth=3;
                config.capturesAudio=YES;config.sampleRate=48000;config.channelCount=2;config.excludesCurrentProcessAudio=YES;
                SCContentFilter *filter=[[SCContentFilter alloc] initWithDisplay:content.displays.firstObject excludingWindows:@[]];
                state.stream=[[SCStream alloc] initWithFilter:filter configuration:config delegate:state];
                NSError *failure=nil;
                if(![state.stream addStreamOutput:state type:SCStreamOutputTypeAudio sampleHandlerQueue:state.queue error:&failure]){state.stream=nil;dispatch_semaphore_signal(ready);return;}
                state.starting=YES;
                [state.stream startCaptureWithCompletionHandler:^(NSError *error){dispatch_async(state.queue, ^{
                    state.starting=NO;code=(error || state.stopped)?4:0;
                    if(state.stopped){NSError *ignored=nil;[state.stream removeStreamOutput:state type:SCStreamOutputTypeAudio error:&ignored];[state.stream stopCaptureWithCompletionHandler:^(NSError *error){state.stream=nil;}];}
                    dispatch_semaphore_signal(ready);
                });}];
            });
        }];
        if(dispatch_semaphore_wait(ready,dispatch_time(DISPATCH_TIME_NOW,8*NSEC_PER_SEC))!=0 || code){pp_rc_audio_stop((__bridge_retained void *)state);return 4;}
        *output=(__bridge_retained void *)state;return 0;
    }return 8;
}
int32_t pp_rc_audio_next(void *handle,uint8_t **bytes,size_t *length,uint64_t *pts){
    if(!handle || !bytes || !length || !pts)return 4;*bytes=NULL;*length=0;
    if(@available(macOS 13.0,*)){
        PPRemoteAudio *state=(__bridge PPRemoteAudio *)handle;__block int32_t result=1;
        dispatch_sync(state.queue, ^{
            if(state.stopped || state.failure){result=state.failure?:4;return;}
            if(!state.encoder.packets.count)return;
            NSData *packet=state.encoder.packets.firstObject;
            uint8_t *memory=malloc(packet.length);if(!memory){result=4;return;}
            memcpy(memory,packet.bytes,packet.length);*bytes=memory;*length=packet.length;*pts=state.encoder.times.firstObject.unsignedLongLongValue;
            [state.encoder.packets removeObjectAtIndex:0];[state.encoder.times removeObjectAtIndex:0];result=0;
        });return result;
    }return 8;
}
