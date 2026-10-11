#import <Foundation/Foundation.h>
#import <CoreVideo/CoreVideo.h>
#include <assert.h>
#include <unistd.h>
#include "../recording.m"
double pp_mac_screen_scale(void){return 1;}
static dispatch_semaphore_t finished;
static int result=99;
static uint64_t savedFrames=0,savedDuration=0;
static int eventCount=0;static uint64_t eventTime=0;static double eventX=0,eventY=0;
static void eventDone(uint64_t token,uint32_t kind,uint32_t code,double x,double y,uint64_t flags,uint64_t time){eventCount++;eventTime=time;eventX=x;eventY=y;}
static void done(uint64_t token,int32_t code,uint64_t frames,uint64_t elapsed){
    result=code;savedFrames=frames;savedDuration=elapsed;dispatch_semaphore_signal(finished);
}
static void frame(PPRecorder *state,CMTime time) API_AVAILABLE(macos(14.0));
static void frame(PPRecorder *state,CMTime time){
    CVPixelBufferRef image=NULL;
    assert(CVPixelBufferCreate(kCFAllocatorDefault,64,64,kCVPixelFormatType_32BGRA,NULL,&image)==0);
    CVPixelBufferLockBaseAddress(image,0);memset(CVPixelBufferGetBaseAddress(image),0x80,CVPixelBufferGetBytesPerRow(image)*64);CVPixelBufferUnlockBaseAddress(image,0);
    CMVideoFormatDescriptionRef desc=NULL;assert(CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault,image,&desc)==0);
    CMSampleTimingInfo timing={CMTimeMake(1,30),time,kCMTimeInvalid};CMSampleBufferRef sample=NULL;
    assert(CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault,image,desc,&timing,&sample)==0);
    NSMutableDictionary *attachments=(__bridge NSMutableDictionary *)CFArrayGetValueAtIndex(CMSampleBufferGetSampleAttachmentsArray(sample,true),0);
    attachments[SCStreamFrameInfoStatus]=@(SCFrameStatusComplete);
    [state stream:nil didOutputSampleBuffer:sample ofType:SCStreamOutputTypeScreen];
    CFRelease(sample);CFRelease(desc);CVPixelBufferRelease(image);
}

@interface FakeVideoInput : NSObject
@property NSMutableArray<NSNumber *> *times;
@property(getter=isReadyForMoreMediaData) BOOL readyForMoreMediaData;
- (BOOL)appendSampleBuffer:(CMSampleBufferRef)sample;
- (void)markAsFinished;
@end
@implementation FakeVideoInput
- (BOOL)appendSampleBuffer:(CMSampleBufferRef)sample { [self.times addObject:@(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)))];return YES; }
- (void)markAsFinished {}
@end
@interface FakeWriter : NSObject
@property AVAssetWriterStatus status;
- (void)startSessionAtSourceTime:(CMTime)time;
- (void)finishWritingWithCompletionHandler:(void (^)(void))block;
- (void)cancelWriting;
@end
@implementation FakeWriter
- (void)startSessionAtSourceTime:(CMTime)time {}
- (void)finishWritingWithCompletionHandler:(void (^)(void))block {self.status=AVAssetWriterStatusCompleted;block();}
- (void)cancelWriting {}
@end
int main(){@autoreleasepool{
 if(@available(macOS 14.0,*)){
    assert(pp_rec_start(0,NULL,0,NULL,NULL)==1);assert(pp_rec_stop(991)==3);
    PPRecorder *state=[PPRecorder new];state.token=991;state.callback=done;state.fps=30;state.pauseTotal=kCMTimeZero;
    state.queue=dispatch_queue_create("probe.timestamps",DISPATCH_QUEUE_SERIAL);
    FakeVideoInput *input=[FakeVideoInput new];input.times=[NSMutableArray new];input.readyForMoreMediaData=YES;
    state.video=(AVAssetWriterInput *)(id)input;state.writer=(AVAssetWriter *)(id)[FakeWriter new];
    @synchronized(PPRecorder.class){activeRecorder=state;}
    finished=dispatch_semaphore_create(0);CMTime epoch=CMClockGetTime(CMClockGetHostTimeClock());
    for(int i=0;i<20;i++){
        if(i==10){assert(pp_rec_pause(991,true)==0);
            dispatch_sync(state.queue,^{frame(state,CMTimeAdd(epoch,CMTimeMake(i,30)));});assert(state.frames==10);
            usleep(150000);assert(pp_rec_pause(991,false)==0);assert(CMTimeGetSeconds(state.pauseTotal)>=0.14);}
        dispatch_sync(state.queue,^{frame(state,CMTimeAdd(CMTimeAdd(epoch,CMTimeMake(i,30)),state.pauseTotal));});
    }
    assert(input.times.count==20);
    double first=input.times.firstObject.doubleValue;
    for(int i=0;i<20;i++) assert(fabs(input.times[i].doubleValue-first-i/30.0)<0.0001);
    assert(pp_rec_stop(991)==0);assert(dispatch_semaphore_wait(finished,dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_SEC))==0);
    assert(result==0 && savedFrames==20 && savedDuration>=650 && savedDuration<=680);
    assert(pp_rec_pause(991,true)==3 && pp_rec_stop(991)==3);
    // Static capture retains its frame, then the heartbeat and stop extend the video timeline.
    PPRecorder *idle=[PPRecorder new];idle.fps=30;idle.pauseTotal=kCMTimeZero;
    FakeVideoInput *idleInput=[FakeVideoInput new];idleInput.times=[NSMutableArray new];idleInput.readyForMoreMediaData=YES;
    idle.video=(id)idleInput;idle.writer=(id)[FakeWriter new];
    frame(idle,epoch);
    assert([idle repeatLastFrameAt:CMTimeAdd(epoch,CMTimeMake(5,1)) finalFrame:NO]);
    assert(idleInput.times.count==2 && fabs(idleInput.times.lastObject.doubleValue-CMTimeGetSeconds(epoch)-5)<.0001);
    frame(idle,CMTimeAdd(epoch,CMTimeMake(4,1)));assert(idle.frames==2); // late SCK sample cannot reverse time after synthetic highlight/heartbeat frame
    idle.eventSidecar=YES;idle.eventCallback=eventDone;idle.scale=2;idle.sourceRegion=CGRectMake(100,100,128,128);idle.encodedSize=CGSizeMake(64,64);
    [idle recordEvent:1 code:0 x:52 y:55 flags:0 at:CMTimeAdd(epoch,CMTimeMake(5,1))];
    assert(eventCount==1 && eventTime==5000 && eventX==4 && eventY==10);
    [idle recordEvent:1 code:0 x:1 y:1 flags:0 at:CMTimeAdd(epoch,CMTimeMake(5,1))];assert(eventCount==1);
    idle.paused=YES;
    [idle recordEvent:3 code:0 x:0 y:0 flags:0 at:CMTimeAdd(epoch,CMTimeMake(7,1))];assert(eventCount==1);
    assert(![idle repeatLastFrameAt:CMTimeAdd(epoch,CMTimeMake(7,1)) finalFrame:NO]);assert(idle.frames==2);
    idle.paused=NO;idle.pauseTotal=CMTimeMake(2,1);
    assert([idle repeatLastFrameAt:CMTimeAdd(epoch,CMTimeMake(8,1)) finalFrame:NO]);
    assert(fabs(idleInput.times.lastObject.doubleValue-CMTimeGetSeconds(epoch)-6)<.0001);
    [idle recordEvent:3 code:0 x:0 y:0 flags:0 at:CMTimeAdd(epoch,CMTimeMake(8,1))];assert(eventCount==2 && eventTime==6000);
    idle.stopping=YES;
    [idle recordEvent:3 code:0 x:0 y:0 flags:0 at:CMTimeAdd(epoch,CMTimeMake(9,1))];assert(eventCount==2);
    assert([idle repeatLastFrameAt:CMTimeAdd(epoch,CMTimeMake(825,100)) finalFrame:YES]);
    assert(fabs(idleInput.times.lastObject.doubleValue-CMTimeGetSeconds(epoch)-6.25)<.0001);
    PPRecorder *empty=[PPRecorder new];empty.token=992;empty.callback=done;empty.queue=dispatch_queue_create("probe.empty",DISPATCH_QUEUE_SERIAL);
    @synchronized(PPRecorder.class){activeRecorder=empty;}
    dispatch_async(empty.queue,^{[empty finish:0];});
    assert(dispatch_semaphore_wait(finished,dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_SEC))==0);assert(result==6);
    puts("PASS: production sample timing rebases pause; paused frames dropped; stop clears session; idle heartbeat and final frame preserve duration; empty recording fails (mock writer, no encoding)");
 }return 0;
}}
