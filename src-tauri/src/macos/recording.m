#import "recording_frame.h"
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import "recording_audio.h"
#import "recording_overlay.h"
#import <ApplicationServices/ApplicationServices.h>
#include <stdint.h>
#include <unistd.h>
typedef void (*PPRecordCallback)(uint64_t,int32_t,uint64_t,uint64_t);
typedef void (*PPEventCallback)(uint64_t,uint32_t,uint32_t,double,double,uint64_t,uint64_t);
API_AVAILABLE(macos(13.0))
@interface PPRecorder : NSObject <SCStreamOutput, SCStreamDelegate, AVCaptureAudioDataOutputSampleBufferDelegate>
@property uint64_t token;
@property PPRecordCallback callback;
@property PPEventCallback eventCallback;
@property BOOL eventSidecar;
@property id eventMonitor;
@property dispatch_semaphore_t eventSlots;
@property PPClickPainter *painter;
@property CGPoint click;
@property CMTime clickAt;
@property double clickRadius;
@property CGRect sourceRegion;
@property double scale;
@property CGSize encodedSize;
- (void)recordEvent:(uint32_t)kind code:(uint32_t)code x:(double)x y:(double)y flags:(uint64_t)flags at:(CMTime)time;
@property dispatch_queue_t queue;
@property SCStream *stream;
@property AVAssetWriter *writer;
@property AVAssetWriterInput *video;
@property AVAssetWriterInput *audio;
@property PPRecordingAudio *mixer;
@property AVCaptureSession *microphone;
@property dispatch_queue_t captureQueue;
@property id microphoneError;
- (void)consume:(CMSampleBufferRef)sample video:(BOOL)video microphone:(BOOL)microphone finalFrame:(BOOL)finalFrame;
- (BOOL)repeatLastFrameAt:(CMTime)time finalFrame:(BOOL)finalFrame;
@property BOOL paused;
@property BOOL stopping;
@property BOOL sessionStarted;
@property BOOL ownsOutput;
@property CMTime epoch;
@property CMTime pausedAt;
@property CMTime pauseTotal;
@property CMTime lastVideo;
@property CMSampleBufferRef lastSample;
@property dispatch_source_t heartbeat;
@property CMTime stoppedAt;
@property BOOL tailWritten;
@property uint64_t frames;
@property NSInteger fps;
@property int32_t failure;
- (void)finish:(int32_t)failure;
- (void)finishWriterWithRetry:(NSUInteger)attempts;
@end
static PPRecorder *activeRecorder API_AVAILABLE(macos(13.0));
static PPRecorder *recorder(uint64_t token) API_AVAILABLE(macos(13.0));
static PPRecorder *recorder(uint64_t token) {
    @synchronized(PPRecorder.class) { return activeRecorder.token==token ? activeRecorder : nil; }
}
@implementation PPRecorder
- (void)dealloc { if(self.lastSample) CFRelease(self.lastSample); }
- (void)recordEvent:(uint32_t)kind code:(uint32_t)code x:(double)x y:(double)y flags:(uint64_t)flags at:(CMTime)time {
    if(self.stopping || self.paused || !self.sessionStarted) return;
    double seconds=CMTimeGetSeconds(CMTimeSubtract(CMTimeSubtract(time,self.pauseTotal),self.epoch));
    if(!isfinite(seconds) || seconds<0) return;
    double px=x*self.scale-self.sourceRegion.origin.x,py=y*self.scale-self.sourceRegion.origin.y;
    if(kind==1) {
        if(px<0 || py<0 || px>=self.sourceRegion.size.width || py>=self.sourceRegion.size.height) return;
        self.click=CGPointMake(px*self.encodedSize.width/self.sourceRegion.size.width,py*self.encodedSize.height/self.sourceRegion.size.height);self.clickAt=time;
        if(self.painter) {
            [self repeatLastFrameAt:time finalFrame:NO];
            __weak PPRecorder *weak=self;
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW,460*NSEC_PER_MSEC),self.queue, ^{
                PPRecorder *strong=weak;
                if(strong && !strong.stopping && !strong.paused && CMTimeCompare(strong.clickAt,time)==0)
                    [strong repeatLastFrameAt:CMClockGetTime(CMClockGetHostTimeClock()) finalFrame:NO];
            });
        }
    }
    if(self.eventSidecar && self.eventCallback) self.eventCallback(self.token,kind,code,px,py,flags,(uint64_t)(seconds*1000));
}
- (BOOL)repeatLastFrameAt:(CMTime)time finalFrame:(BOOL)finalFrame {
    if(!self.lastSample || !self.sessionStarted) return YES;
    CMTime pts=CMTimeSubtract(time,self.pauseTotal);
    if(CMTimeCompare(pts,self.lastVideo)<=0) return YES;
    if(!self.video.readyForMoreMediaData) return NO;
    CMSampleTimingInfo timing={CMTimeMake(1,MAX(1,self.fps)),time,kCMTimeInvalid};
    CMSampleBufferRef copy=NULL;
    if(CMSampleBufferCreateCopyWithNewTiming(kCFAllocatorDefault,self.lastSample,1,&timing,&copy)!=noErr || !copy) return NO;
    uint64_t before=self.frames;
    [self consume:copy video:YES microphone:NO finalFrame:finalFrame]; CFRelease(copy);
    return self.frames>before;
}
- (void)finish:(int32_t)failure {
    if(self.stopping) return;
    self.stopping=YES; self.failure=failure;
    id monitor=self.eventMonitor;self.eventMonitor=nil;
    if(monitor) dispatch_async(dispatch_get_main_queue(), ^{ [NSEvent removeMonitor:monitor]; });
    self.stoppedAt=self.paused ? self.pausedAt : CMClockGetTime(CMClockGetHostTimeClock());
    if(self.heartbeat) { dispatch_source_cancel(self.heartbeat); self.heartbeat=nil; }
    if(self.microphoneError) { [NSNotificationCenter.defaultCenter removeObserver:self.microphoneError]; self.microphoneError=nil; }
    void (^finalize)(void)=^{
        dispatch_async(self.queue, ^{
            if(self.stream) {
                [self.stream removeStreamOutput:self type:SCStreamOutputTypeScreen error:nil];
                [self.stream removeStreamOutput:self type:SCStreamOutputTypeAudio error:nil];
                self.stream=nil;
            }
            if(self.sessionStarted && self.frames) {
                [self finishWriterWithRetry:40];
            } else {
                [self.writer cancelWriting];
                if(self.ownsOutput) [NSFileManager.defaultManager removeItemAtURL:self.writer.outputURL error:nil];
                @synchronized(PPRecorder.class) { if(activeRecorder==self) activeRecorder=nil; }
                if(self.callback) self.callback(self.token,self.failure ?: 6,0,0);
            }
        });
    };
    void (^stopScreen)(void)=^{
        if(self.stream) [self.stream stopCaptureWithCompletionHandler:^(NSError *error){ finalize(); }];
        else finalize();
    };
    if(self.microphone) dispatch_async(self.captureQueue, ^{
        [self.microphone stopRunning];
        for(AVCaptureOutput *output in self.microphone.outputs) if([output isKindOfClass:AVCaptureAudioDataOutput.class]) [(AVCaptureAudioDataOutput *)output setSampleBufferDelegate:nil queue:NULL];
        stopScreen();
    });
    else stopScreen();
}
- (void)finishWriterWithRetry:(NSUInteger)attempts {
    if(!self.failure && !self.tailWritten) {
        if(![self repeatLastFrameAt:self.stoppedAt finalFrame:YES]) {
            if(attempts && self.writer.status==AVAssetWriterStatusWriting) {
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW,50*NSEC_PER_MSEC),self.queue, ^{ [self finishWriterWithRetry:attempts-1]; }); return;
            }
            self.failure=5;
        }
        self.tailWritten=YES;
    }
    if(self.mixer && ![self.mixer flushThrough:CMTimeAdd(self.lastVideo,CMTimeMake(1,MAX(1,self.fps)))]) {
        if(attempts && self.writer.status==AVAssetWriterStatusWriting) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW,50*NSEC_PER_MSEC),self.queue, ^{ [self finishWriterWithRetry:attempts-1]; });
            return;
        }
        self.failure=self.failure ?: 5;
    }
                [self.video markAsFinished]; [self.audio markAsFinished];
                [self.writer finishWritingWithCompletionHandler:^{
                    int32_t status=self.failure ?: (self.writer.status==AVAssetWriterStatusCompleted ? 0 : 5);
                    if(status && self.ownsOutput) [NSFileManager.defaultManager removeItemAtURL:self.writer.outputURL error:nil];
                    @synchronized(PPRecorder.class) { if(activeRecorder==self) activeRecorder=nil; }
                    double seconds=CMTimeGetSeconds(CMTimeSubtract(self.lastVideo,self.epoch));
                    uint64_t duration=isfinite(seconds) && seconds>=0 ? (uint64_t)(seconds*1000)+1000/MAX(1,self.fps) : 0;
                    if(self.lastSample) { CFRelease(self.lastSample); self.lastSample=NULL; }
                    if(self.callback) self.callback(self.token,status,self.frames,duration);
                }];
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    dispatch_async(self.queue, ^{ [self finish:4]; });
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    BOOL video=(type==SCStreamOutputTypeScreen);
    if(!video && type!=SCStreamOutputTypeAudio) return;
    if(video) {
        NSArray *attachments=(__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample,false);
        NSNumber *status=attachments.firstObject[SCStreamFrameInfoStatus];
        if(!status || status.integerValue!=SCFrameStatusComplete) return;
    }
    [self consume:sample video:video microphone:NO finalFrame:NO];
}
- (void)captureOutput:(AVCaptureOutput *)output didOutputSampleBuffer:(CMSampleBufferRef)sample fromConnection:(AVCaptureConnection *)connection {
    [self consume:sample video:NO microphone:YES finalFrame:NO];
}
- (void)consume:(CMSampleBufferRef)sample video:(BOOL)video microphone:(BOOL)microphone finalFrame:(BOOL)finalFrame {
    if((!finalFrame && (self.stopping || self.paused)) || !CMSampleBufferDataIsReady(sample)) return;
    CMTime original=CMSampleBufferGetPresentationTimeStamp(sample);
    if(microphone && self.microphone.masterClock) original=CMSyncConvertTime(original,self.microphone.masterClock,CMClockGetHostTimeClock());
    CMTime pts=CMTimeSubtract(original,self.pauseTotal);
    if(!CMTIME_IS_NUMERIC(pts)) return;
    if(!self.sessionStarted) {
        if(!video) return;
        [self.writer startSessionAtSourceTime:pts]; self.epoch=pts; self.sessionStarted=YES;
        if(self.microphone) self.mixer=[[PPRecordingAudio alloc] initWithInput:self.audio epoch:pts];
    }
    if(CMTimeCompare(pts,self.epoch)<0 || (video && self.frames && CMTimeCompare(pts,self.lastVideo)<=0)) return;
    if(!video && self.mixer) {
        if(![self.mixer append:sample at:pts microphone:microphone]) [self finish:5];
        return;
    }
    AVAssetWriterInput *input=video ? self.video : self.audio;
    if(!input || !input.readyForMoreMediaData) return;
    CMItemCount count=0;
    if(CMSampleBufferGetSampleTimingInfoArray(sample,0,NULL,&count)!=noErr || count<=0 || count>4096) { [self finish:5]; return; }
    CMSampleTimingInfo *timings=calloc((size_t)count,sizeof(CMSampleTimingInfo));
    if(!timings) { [self finish:5]; return; }
    OSStatus code=CMSampleBufferGetSampleTimingInfoArray(sample,count,timings,NULL);
    for(CMItemCount i=0;i<count;i++) {
        timings[i].presentationTimeStamp=CMTimeSubtract(timings[i].presentationTimeStamp,self.pauseTotal);
        if(CMTIME_IS_NUMERIC(timings[i].decodeTimeStamp)) timings[i].decodeTimeStamp=CMTimeSubtract(timings[i].decodeTimeStamp,self.pauseTotal);
    }
    CMSampleBufferRef painted=NULL;
    if(video && self.painter && CMTIME_IS_NUMERIC(self.clickAt)) {
        double age=CMTimeGetSeconds(CMTimeSubtract(original,self.clickAt));
        if(isfinite(age) && age>=0 && age<=.45) {
            painted=[self.painter copySample:sample x:self.click.x y:self.click.y radius:self.clickRadius age:age];
            if(!painted) { free(timings);if(!self.painter.backpressured) [self finish:14];return; }
        }
    }
    CMSampleBufferRef adjusted=NULL;
    if(code==noErr) code=CMSampleBufferCreateCopyWithNewTiming(kCFAllocatorDefault,painted ?: sample,count,timings,&adjusted);
    if(painted) CFRelease(painted);
    free(timings);
    if(code!=noErr || !adjusted) { [self finish:5]; return; }
    BOOL ok=[input appendSampleBuffer:adjusted]; CFRelease(adjusted);
    if(!ok) { [self finish:5]; return; }
    if(video) {
        self.frames++; self.lastVideo=pts;
        CFRetain(sample); if(self.lastSample) CFRelease(self.lastSample); self.lastSample=sample;
    }
}
@end
int32_t pp_rec_start(uint64_t token,const uint8_t *json,size_t length,PPRecordCallback callback,PPEventCallback eventCallback) {
    if(!token || !json || !callback || length>65536) return 1;
    if(NSThread.isMainThread) return 9;
    if(!CGPreflightScreenCaptureAccess()) return 2;
    if(@available(macOS 13.0,*)) {
        @autoreleasepool {
            NSDictionary *cfg=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:length] options:0 error:nil];
            if(![cfg isKindOfClass:NSDictionary.class] || ![cfg[@"path"] isKindOfClass:NSString.class]) return 1;
            if(![cfg[@"path"] isAbsolutePath] || [cfg[@"path"] length]==0) return 1;
            for(NSString *key in @[@"width",@"height",@"sourceWidth",@"sourceHeight",@"fps",@"bitrate",@"x",@"y",@"sysAudio",@"micAudio",@"scale"])
                if(![cfg[key] isKindOfClass:NSNumber.class] || !isfinite([cfg[key] doubleValue])) return 1;
            if([cfg[@"scale"] doubleValue]<1 || [cfg[@"scale"] doubleValue]>8 || [cfg[@"width"] integerValue]<2 || [cfg[@"height"] integerValue]<2 ||
               [cfg[@"width"] doubleValue]*[cfg[@"height"] doubleValue]>40000000 ||
               [cfg[@"sourceWidth"] integerValue]<16 || [cfg[@"sourceHeight"] integerValue]<16 ||
               [cfg[@"fps"] integerValue]<1 || [cfg[@"fps"] integerValue]>60 || [cfg[@"bitrate"] integerValue]<=0) return 1;
            if([cfg[@"micAudio"] boolValue]) {
                NSString *usage=[NSBundle.mainBundle objectForInfoDictionaryKey:@"NSMicrophoneUsageDescription"];
                if(![usage isKindOfClass:NSString.class] || usage.length==0) return 13;
                AVAuthorizationStatus permission=[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
                if(permission!=AVAuthorizationStatusAuthorized) {
                    if(permission==AVAuthorizationStatusNotDetermined) [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted){}];
                    return 10; // A permission prompt is never counted as a recording start.
                }
            }
            if([cfg[@"eventSidecar"] boolValue] && (!eventCallback || !AXIsProcessTrusted())) return 15;
            if([NSFileManager.defaultManager fileExistsAtPath:cfg[@"path"]]) return 3;
            PPRecorder *state=[PPRecorder new]; state.token=token; state.callback=callback;
            state.queue=dispatch_queue_create("pastepanda.macos.recording",DISPATCH_QUEUE_SERIAL);
            state.pauseTotal=kCMTimeZero; state.fps=[cfg[@"fps"] integerValue];
            state.eventCallback=eventCallback;state.eventSidecar=[cfg[@"eventSidecar"] boolValue];state.clickAt=kCMTimeInvalid;
            state.scale=[cfg[@"scale"] doubleValue];state.sourceRegion=CGRectMake([cfg[@"x"] doubleValue],[cfg[@"y"] doubleValue],[cfg[@"sourceWidth"] doubleValue],[cfg[@"sourceHeight"] doubleValue]);
            state.encodedSize=CGSizeMake([cfg[@"width"] doubleValue],[cfg[@"height"] doubleValue]);
            if([cfg[@"clickHighlight"] boolValue]) {state.painter=[PPClickPainter new];state.clickRadius=18*state.scale*state.encodedSize.width/state.sourceRegion.size.width;}
            if([cfg[@"micAudio"] boolValue]) {
                AVCaptureDevice *device=[AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
                if(!device) return 12;
                NSError *micError=nil;
                AVCaptureDeviceInput *input=[AVCaptureDeviceInput deviceInputWithDevice:device error:&micError];
                AVCaptureAudioDataOutput *output=[AVCaptureAudioDataOutput new];
                output.audioSettings=@{AVFormatIDKey:@(kAudioFormatLinearPCM),AVLinearPCMIsFloatKey:@YES,AVLinearPCMBitDepthKey:@32,AVLinearPCMIsNonInterleaved:@NO};
                [output setSampleBufferDelegate:state queue:state.queue];
                state.microphone=[AVCaptureSession new];
                state.captureQueue=dispatch_queue_create("pastepanda.macos.microphone",DISPATCH_QUEUE_SERIAL);
                if(!input || micError || ![state.microphone canAddInput:input] || ![state.microphone canAddOutput:output]) return 11;
                [state.microphone addInput:input]; [state.microphone addOutput:output];
            }
            @synchronized(PPRecorder.class) { if(activeRecorder) return 3; activeRecorder=state; }
            if(state.microphone) {
                __weak PPRecorder *weakState=state;
                state.microphoneError=[NSNotificationCenter.defaultCenter addObserverForName:AVCaptureSessionRuntimeErrorNotification object:state.microphone queue:nil usingBlock:^(NSNotification *note){
                    PPRecorder *strong=weakState;
                    if(strong) dispatch_async(strong.queue, ^{ [strong finish:11]; });
                }];
            }
            if(state.painter || state.eventSidecar) {
                state.eventSlots=dispatch_semaphore_create(64);
                dispatch_sync(dispatch_get_main_queue(), ^{
                    NSEventMask mask=NSEventMaskLeftMouseDown|NSEventMaskRightMouseDown|NSEventMaskOtherMouseDown;
                    if(state.eventSidecar) mask|=NSEventMaskKeyDown;
                    __weak PPRecorder *weak=state;
                    state.eventMonitor=[NSEvent addGlobalMonitorForEventsMatchingMask:mask handler:^(NSEvent *event){
                        BOOL key=event.type==NSEventTypeKeyDown;
                        PPRecorder *strong=weak;if(!strong || (key && event.isARepeat) || (!key && !event.CGEvent) || dispatch_semaphore_wait(strong.eventSlots,DISPATCH_TIME_NOW)!=0) return;
                        CGPoint point=key ? CGPointZero : CGEventGetLocation(event.CGEvent);
                        uint32_t code=key ? event.keyCode : (event.type==NSEventTypeLeftMouseDown ? 0 : event.type==NSEventTypeRightMouseDown ? 1 : 2);
                        uint64_t flags=event.modifierFlags;
                        CMTime time=CMTimeMakeWithSeconds(event.timestamp,1000000000);
                        dispatch_async(strong.queue, ^{ [strong recordEvent:key ? 2 : 1 code:code x:point.x y:point.y flags:flags at:time];dispatch_semaphore_signal(strong.eventSlots); });
                    }];
                });
                if(!state.eventMonitor) { dispatch_async(state.queue, ^{ [state finish:16]; });return 16; }
            }
            dispatch_semaphore_t ready=dispatch_semaphore_create(0);
            __block int32_t outcome=4;
            [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent *content,NSError *error){
                dispatch_async(state.queue, ^{
                    if(state.stopping) { dispatch_semaphore_signal(ready); return; }
                    SCDisplay *display=nil;
                    for(SCDisplay *d in content.displays) if(d.displayID==[cfg[@"displayId"] unsignedIntValue]) display=d;
                    if(!display && content.displays.count==1) display=content.displays.firstObject;
                    if(error || !display) { [state finish:4]; dispatch_semaphore_signal(ready); return; }
                    NSError *writerError=nil;
                    state.writer=[[AVAssetWriter alloc] initWithURL:[NSURL fileURLWithPath:cfg[@"path"]] fileType:AVFileTypeMPEG4 error:&writerError];
                    NSDictionary *compression=@{AVVideoAverageBitRateKey:cfg[@"bitrate"],AVVideoExpectedSourceFrameRateKey:cfg[@"fps"],AVVideoMaxKeyFrameIntervalDurationKey:@1,AVVideoAllowFrameReorderingKey:@NO};
                    NSMutableDictionary *settings=[@{AVVideoCodecKey:[cfg[@"codec"] isEqual:@"hevc"] ? AVVideoCodecTypeHEVC : AVVideoCodecTypeH264,
                        AVVideoWidthKey:cfg[@"width"],AVVideoHeightKey:cfg[@"height"],AVVideoCompressionPropertiesKey:compression} mutableCopy];
                    if(![state.writer canApplyOutputSettings:settings forMediaType:AVMediaTypeVideo]) settings[AVVideoCodecKey]=AVVideoCodecTypeH264;
                    state.video=[AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:settings];
                    state.video.expectsMediaDataInRealTime=YES;
                    if(!state.writer || ![state.writer canAddInput:state.video]) { [state finish:5]; dispatch_semaphore_signal(ready); return; }
                    [state.writer addInput:state.video];
                    if([cfg[@"sysAudio"] boolValue] || state.microphone) {
                        state.audio=[AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeAudio outputSettings:@{AVFormatIDKey:@(kAudioFormatMPEG4AAC),AVSampleRateKey:@48000,AVNumberOfChannelsKey:@2,AVEncoderBitRateKey:@128000}];
                        state.audio.expectsMediaDataInRealTime=YES;
                        if(![state.writer canAddInput:state.audio]) { [state finish:5]; dispatch_semaphore_signal(ready); return; }
                        [state.writer addInput:state.audio];
                    }
                    if(![state.writer startWriting]) { [state finish:5]; dispatch_semaphore_signal(ready); return; }
                    state.ownsOutput=YES;
                    // SCK can omit complete frames while the screen is static. Keep a
                    // one-second video cadence, then append the exact stop-time frame.
                    state.heartbeat=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,state.queue);
                    dispatch_source_set_timer(state.heartbeat,dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),NSEC_PER_SEC,50*NSEC_PER_MSEC);
                    __weak PPRecorder *weak=state;
                    dispatch_source_set_event_handler(state.heartbeat, ^{
                        PPRecorder *strong=weak;
                        if(!strong || strong.stopping || strong.paused || !strong.sessionStarted) return;
                        CMTime now=CMClockGetTime(CMClockGetHostTimeClock());
                        double gap=CMTimeGetSeconds(CMTimeSubtract(CMTimeSubtract(now,strong.pauseTotal),strong.lastVideo));
                        if(isfinite(gap) && gap>=0.9) [strong repeatLastFrameAt:now finalFrame:NO];
                    });
                    dispatch_resume(state.heartbeat);
                    NSMutableArray *excluded=[NSMutableArray new];
                    for(SCRunningApplication *app in content.applications) if(app.processID==getpid()) [excluded addObject:app];
                    SCContentFilter *filter=[[SCContentFilter alloc] initWithDisplay:display excludingApplications:excluded exceptingWindows:@[]];
                    SCStreamConfiguration *config=[SCStreamConfiguration new];
                    double scale=[cfg[@"scale"] doubleValue];
                    config.sourceRect=CGRectMake(([cfg[@"x"] doubleValue]-[cfg[@"displayX"] doubleValue])/scale,([cfg[@"y"] doubleValue]-[cfg[@"displayY"] doubleValue])/scale,[cfg[@"sourceWidth"] doubleValue]/scale,[cfg[@"sourceHeight"] doubleValue]/scale);
                    config.width=[cfg[@"width"] unsignedIntegerValue]; config.height=[cfg[@"height"] unsignedIntegerValue];
                    if(state.painter) config.pixelFormat=kCVPixelFormatType_32BGRA;
                    if([cfg[@"externalVideo"] boolValue]){config.sourceRect=CGRectZero;config.width=16;config.height=16;}
                    config.minimumFrameInterval=CMTimeMake(1,[cfg[@"externalVideo"] boolValue]?1:[cfg[@"fps"] intValue]); config.queueDepth=3; config.showsCursor=YES;
                    config.capturesAudio=[cfg[@"sysAudio"] boolValue]; config.sampleRate=48000; config.channelCount=2; config.excludesCurrentProcessAudio=YES;
                    state.stream=[[SCStream alloc] initWithFilter:filter configuration:config delegate:state];
                    NSError *outputError=nil;
                    BOOL ok=[cfg[@"externalVideo"] boolValue] || [state.stream addStreamOutput:state type:SCStreamOutputTypeScreen sampleHandlerQueue:state.queue error:&outputError];
                    if(ok && [cfg[@"sysAudio"] boolValue]) ok=[state.stream addStreamOutput:state type:SCStreamOutputTypeAudio sampleHandlerQueue:state.queue error:&outputError];
                    if(!ok) { [state finish:4]; dispatch_semaphore_signal(ready); return; }
                    [state.stream startCaptureWithCompletionHandler:^(NSError *startError){
                        dispatch_async(state.queue, ^{
                            outcome=(startError || state.stopping) ? 4 : 0;
                            if(state.stopping) { dispatch_semaphore_signal(ready); return; }
                            if(startError) { [state finish:4]; dispatch_semaphore_signal(ready); }
                            else if(state.microphone) {
                                dispatch_async(state.captureQueue, ^{
                                    [state.microphone startRunning];
                                    BOOL running=state.microphone.running;
                                    dispatch_async(state.queue, ^{
                                        if(!running || state.stopping) { outcome=11; [state finish:11]; }
                                        dispatch_semaphore_signal(ready);
                                    });
                                });
                            } else dispatch_semaphore_signal(ready);
                        });
                    }];
                });
            }];
            if(dispatch_semaphore_wait(ready,dispatch_time(DISPATCH_TIME_NOW,8*NSEC_PER_SEC))!=0) {
                dispatch_async(state.queue, ^{ [state finish:4]; }); return 4;
            }
            return outcome;
        }
    }
    return 8;
}
int32_t pp_rec_stop(uint64_t token) {
    if(@available(macOS 13.0,*)) {
    PPRecorder *state=recorder(token); if(!state) return 3;
    dispatch_async(state.queue, ^{ [state finish:0]; }); return 0;

    }
    return 8;
}
int32_t pp_rec_pause(uint64_t token,bool paused) {
    if(@available(macOS 13.0,*)) {
    PPRecorder *state=recorder(token); if(!state) return 3;
    __block int32_t result=0;
    dispatch_sync(state.queue, ^{
        if(state.stopping) { result=3; return; }
        if(state.paused==paused) return;
        CMTime now=CMClockGetTime(CMClockGetHostTimeClock());
        if(paused) state.pausedAt=now;
        else state.pauseTotal=CMTimeAdd(state.pauseTotal,CMTimeSubtract(now,state.pausedAt));
        state.paused=paused;
    }); return result;

    }
    return 8;
}
int32_t pp_rec_progress(uint64_t token,uint64_t *frames,uint64_t *elapsed) {
    if(@available(macOS 13.0,*)) {
    PPRecorder *state=recorder(token); if(!state || !frames || !elapsed) return 3;
    dispatch_sync(state.queue, ^{
        *frames=state.frames;
        double duration=state.sessionStarted ? CMTimeGetSeconds(CMTimeSubtract(state.lastVideo,state.epoch)) : 0;
        *elapsed=isfinite(duration) && duration>0 ? (uint64_t)(duration*1000) : 0;
    }); return 0;

    }
    return 8;
}

int32_t pp_rec_mark(uint64_t token) {
    if(@available(macOS 13.0,*)) { PPRecorder *state=recorder(token);if(!state)return 3;
        CMTime time=CMClockGetTime(CMClockGetHostTimeClock());
        dispatch_async(state.queue, ^{[state recordEvent:3 code:0 x:0 y:0 flags:0 at:time];});return 0;
    }return 8;
}

// Composite video uses the same writer, pause rebasing and final-frame path as SCK.
int32_t pp_rec_submit_rgba(uint64_t token,const uint8_t *rgba,size_t length,uint32_t width,uint32_t height){
    if(@available(macOS 13.0,*)){
        PPRecorder *state=recorder(token);if(!state)return 3;
        __block int32_t result=0;
        dispatch_sync(state.queue,^{
            if(state.stopping){result=3;return;}if(state.paused)return;
            if(width!=(uint32_t)state.encodedSize.width || height!=(uint32_t)state.encodedSize.height){result=5;return;}
            CMSampleBufferRef sample=pp_recording_sample(rgba,length,width,height,CMClockGetTime(CMClockGetHostTimeClock()));
            if(!sample){result=5;[state finish:5];return;}
            [state consume:sample video:YES microphone:NO finalFrame:NO];CFRelease(sample);
            if(state.failure)result=state.failure;
        });return result;
    }return 8;
}
int32_t pp_rec_fail(uint64_t token,int32_t code){
    if(@available(macOS 13.0,*)){PPRecorder *state=recorder(token);if(!state)return 3;
        dispatch_async(state.queue,^{[state finish:code ?: 4];});return 0;
    }return 8;
}
