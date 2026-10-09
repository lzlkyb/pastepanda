#import <AVFoundation/AVFoundation.h>
// Access only on the recording serial queue. No microphone device is opened here.
@interface PPRecordingAudio : NSObject
- (instancetype)initWithInput:(AVAssetWriterInput *)input epoch:(CMTime)epoch;
- (BOOL)append:(CMSampleBufferRef)sample at:(CMTime)pts microphone:(BOOL)microphone;
- (BOOL)flushThrough:(CMTime)end;
@end
