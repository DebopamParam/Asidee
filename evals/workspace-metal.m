#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

int main(void) {
    @autoreleasepool {
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (!device) return 1;
        NSError *error = nil;
        NSString *source = @"#include <metal_stdlib>\nusing namespace metal; kernel void add(device uint *x [[buffer(0)]], uint i [[thread_position_in_grid]]) { x[i] = i + 7; }";
        id<MTLLibrary> library = [device newLibraryWithSource:source options:nil error:&error];
        if (!library) return 2;
        id<MTLComputePipelineState> pipeline = [device newComputePipelineStateWithFunction:[library newFunctionWithName:@"add"] error:&error];
        if (!pipeline) return 3;
        id<MTLBuffer> buffer = [device newBufferWithLength:256 * sizeof(unsigned) options:MTLResourceStorageModeShared];
        id<MTLCommandQueue> queue = [device newCommandQueue];
        id<MTLCommandBuffer> command = [queue commandBuffer];
        id<MTLComputeCommandEncoder> encoder = [command computeCommandEncoder];
        [encoder setComputePipelineState:pipeline];
        [encoder setBuffer:buffer offset:0 atIndex:0];
        [encoder dispatchThreads:MTLSizeMake(256, 1, 1) threadsPerThreadgroup:MTLSizeMake(32, 1, 1)];
        [encoder endEncoding]; [command commit]; [command waitUntilCompleted];
        if (command.status != MTLCommandBufferStatusCompleted) return 4;
        unsigned *values = buffer.contents;
        for (unsigned i = 0; i < 256; i++) if (values[i] != i + 7) return 5;
        printf("Metal compute verified on %s\n", device.name.UTF8String);
        return 0;
    }
}
