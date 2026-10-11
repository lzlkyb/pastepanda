#import <AVFoundation/AVFoundation.h>
// Serialized by the capture queue. Holds at most 64 AAC packets.
@interface PPRemoteAudioEncoder : NSObject
@property(readonly) NSMutableArray<NSData *> *packets;
@property(readonly) NSMutableArray<NSNumber *> *times;
- (BOOL)append:(CMSampleBufferRef)sample;
@end
