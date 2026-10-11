#import <Foundation/Foundation.h>
#include <assert.h>
#include "../remote_capture.m"
extern int32_t pp_rc_video_open(bool,uint32_t,uint32_t,uint32_t,uint32_t,void **);
extern void pp_rc_video_close(void *);
@interface FakeRemoteStream:NSObject
@property dispatch_semaphore_t done;
- (void)stopCaptureWithCompletionHandler:(void (^)(NSError *))callback;
@end
@implementation FakeRemoteStream
- (void)stopCaptureWithCompletionHandler:(void (^)(NSError *))callback {callback(nil);dispatch_semaphore_signal(self.done);}
@end
int main(){@autoreleasepool {if(@available(macOS 14.0,*)){
    assert(pp_rc_host_ready()==9); // no NSApplication; no permission prompt or desktop access
    PPRemoteCapture *state=[PPRemoteCapture new];state.queue=dispatch_queue_create("probe.remote",DISPATCH_QUEUE_SERIAL);state.first=dispatch_semaphore_create(0);
    CVPixelBufferRef pixels=NULL;assert(CVPixelBufferCreate(NULL,64,32,kCVPixelFormatType_32BGRA,NULL,&pixels)==0);
    CVPixelBufferLockBaseAddress(pixels,0);for(size_t y=0;y<32;y++){uint8_t *row=(uint8_t *)CVPixelBufferGetBaseAddress(pixels)+y*CVPixelBufferGetBytesPerRow(pixels);for(size_t x=0;x<64;x++){row[x*4]=11;row[x*4+1]=22;row[x*4+2]=33;row[x*4+3]=0;}}CVPixelBufferUnlockBaseAddress(pixels,0);state.latest=pixels;
    void *handle=(__bridge_retained void *)state;uint8_t *out=NULL;size_t count=0;uint32_t w=0,h=0;
    assert(pp_rc_capture_frame(handle,&out,&count,&w,&h)==0 && w==64 && h==32 && count==64*32*4);
    for(size_t i=0;i<count;i+=4)assert(out[i]==33 && out[i+1]==22 && out[i+2]==11 && out[i+3]==255);free(out);
    // The direct path must skip duplicate source buffers and reject CPU-only pixels.
    void *encoder=NULL;assert(pp_rc_video_open(false,64,32,30,1000000,&encoder)==0);bool key=false;char codec[64]={0};
    state.sequence=1;assert(pp_rc_capture_encode(handle,encoder,true,&out,&count,&key,codec,sizeof(codec))==9);
    state.lastEncoded=1;assert(pp_rc_capture_encode(handle,encoder,false,&out,&count,&key,codec,sizeof(codec))==10);
    pp_rc_video_close(encoder);
    FakeRemoteStream *stream=[FakeRemoteStream new];stream.done=dispatch_semaphore_create(0);state.stream=(id)stream;pp_rc_capture_stop(handle);
    assert(dispatch_semaphore_wait(stream.done,dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC))==0 && state.stopped && !state.stream);
    out=NULL;count=0;assert(pp_rc_capture_frame((__bridge void *)state,&out,&count,&w,&h)==4 && !out && !count);
    puts("PASS: latest BGRA frame copies as RGBA; stopped session exposes no frame and releases stream; no-app preflight fails (mock stream, no screen capture)");
}return 0;}}
