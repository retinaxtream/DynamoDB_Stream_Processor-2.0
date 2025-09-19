// ===================================
// DynamoDB Stream Processor Lambda Function
// Process face_match_results table changes and trigger email notifications
// ===================================

import { DynamoDBClient, UpdateItemCommand,QueryCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

// Configuration
const CONFIG = {
  AWS_REGION: process.env.AWS_REGION || 'ap-south-1',
  EMAIL_QUEUE_URL: process.env.EMAIL_QUEUE_URL,
  ENABLE_METRICS: process.env.ENABLE_METRICS !== 'false',
  ENABLE_DEBUG_LOGGING: process.env.ENABLE_DEBUG_LOGGING === 'true',

  // Business logic thresholds
  MIN_MATCHES_FOR_EMAIL: parseInt(process.env.MIN_MATCHES_FOR_EMAIL || '1'),

  // Error handling
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '3'),
  RETRY_DELAY_MS: parseInt(process.env.RETRY_DELAY_MS || '1000'),
};

// Initialize AWS clients
const dynamoClient = new DynamoDBClient({ region: CONFIG.AWS_REGION });
const sqsClient = new SQSClient({ region: CONFIG.AWS_REGION });
const cloudwatchClient = new CloudWatchClient({ region: CONFIG.AWS_REGION });

// ===================================
// Main Lambda Handler
// ===================================

export const handler = async (event, context) => {
  console.log('🔄 DynamoDB Stream Processor started');
  console.log(`📊 Processing ${event.Records.length} stream records`);

  if (CONFIG.ENABLE_DEBUG_LOGGING) {
    console.log('📋 Stream Event:', JSON.stringify(event, null, 2));
  }

  const metrics = {
    totalRecords: event.Records.length,
    processedRecords: 0,
    emailsTriggered: 0,
    skippedRecords: 0,
    errorRecords: 0,
    duplicatesPrevented: 0,
  };

  const results = [];

  for (const record of event.Records) {
    try {
      console.log(`\n🔍 Processing record: ${record.eventID}`);
      console.log(`   Event Name: ${record.eventName}`);
      console.log(`   Event Source: ${record.eventSourceARN}`);

      const result = await processStreamRecord(record);
      results.push(result);

      metrics.processedRecords++;
      if (result.action === 'email_triggered') {
        metrics.emailsTriggered++;
      } else if (result.action === 'skipped') {
        metrics.skippedRecords++;
      } else if (result.action === 'duplicate_prevented') {
        metrics.duplicatesPrevented++;
      }
    } catch (error) {
      console.error(`❌ Error processing record ${record.eventID}:`, error);
      metrics.errorRecords++;

      results.push({
        recordId: record.eventID,
        action: 'error',
        error: error.message,
      });
    }
  }

  if (CONFIG.ENABLE_METRICS) {
    await publishMetrics(metrics);
  }

  console.log('\n📊 Processing Summary:');
  console.log(`   Total Records: ${metrics.totalRecords}`);
  console.log(`   Processed Successfully: ${metrics.processedRecords}`);
  console.log(`   Emails Triggered: ${metrics.emailsTriggered}`);
  console.log(`   Skipped: ${metrics.skippedRecords}`);
  console.log(`   Duplicates Prevented: ${metrics.duplicatesPrevented}`);
  console.log(`   Errors: ${metrics.errorRecords}`);

  return {
    batchItemFailures: results
      .filter((r) => r.action === 'error')
      .map((r) => ({ itemIdentifier: r.recordId })),
    summary: metrics,
    processedAt: new Date().toISOString(),
  };
};

// ===================================
// Stream Record Processing
// ===================================

async function checkEmailJobExists(eventId, email) {
  try {
    console.log(`   🔍 Checking if email job exists for: ${email}`);
    
    const command = new QueryCommand({
      TableName: 'face_match_results',
      KeyConditionExpression: 'eventId = :eventId',
      FilterExpression: 'guest_email = :email AND (delivery_status = :processing OR delivery_status = :delivered OR email_status = :sent)',
      ExpressionAttributeValues: {
        ':eventId': { S: eventId },
        ':email': { S: email.toLowerCase() },
        ':processing': { S: 'processing' },
        ':delivered': { S: 'delivered' },
        ':sent': { S: 'sent' }
      }
    });
    
    const result = await dynamoClient.send(command);
    const exists = result.Items && result.Items.length > 0;
    
    if (exists) {
      console.log(`   ⚠️ Found existing email job for ${email}`);
      console.log(`   Existing records: ${result.Items.length}`);
      result.Items.forEach(item => {
        console.log(`     - guestId: ${item.guestId?.S}, status: ${item.delivery_status?.S || item.email_status?.S}`);
      });
    }
    
    return exists;
  } catch (error) {
    console.error(`   ❌ Error checking email job existence: ${error.message}`);
    // Don't fail the entire process if check fails
    return false;
  }
}


async function processStreamRecord(record) {
  const { eventName, dynamodb } = record;

  if (!['INSERT', 'MODIFY'].includes(eventName)) {
    console.log(`   ⏭️  Skipping ${eventName} event`);
    return {
      recordId: record.eventID,
      action: 'skipped',
      reason: `Event type ${eventName} not relevant`,
    };
  }

  if (!dynamodb?.NewImage) {
    console.log('   ⏭️  No NewImage in record, skipping');
    return {
      recordId: record.eventID,
      action: 'skipped',
      reason: 'No NewImage data',
    };
  }

  const matchResult = parseDynamoDBRecord(dynamodb.NewImage);

    // CRITICAL FIX: Check if email was already sent in the CURRENT record
    if (matchResult.email_status === 'sent' || matchResult.email_sent === true) {
      console.log(`   ✅ Email already sent for ${matchResult.guestEmail} (status: ${matchResult.email_status})`);
      return {
        recordId: record.eventID,
        action: 'skipped',
        reason: 'Email already sent - found in current record'
      };
    }

      // For MODIFY events, also check the OLD image to see if email was already sent
  if (eventName === 'MODIFY' && dynamodb?.OldImage) {
    const oldRecord = parseDynamoDBRecord(dynamodb.OldImage);
    
    if (oldRecord.email_status === 'sent' || oldRecord.email_sent === true) {
      console.log(`   ✅ Email was already sent in previous version for ${matchResult.guestEmail}`);
      return {
        recordId: record.eventID,
        action: 'skipped',
        reason: 'Email already sent - found in old record'
      };
    }
  }

  if (CONFIG.ENABLE_DEBUG_LOGGING) {
    console.log('   📋 Parsed match result:', JSON.stringify(matchResult, null, 2));
  }

   // Check if email job already exists
   const emailExists = await checkEmailJobExists(
    matchResult.eventId,
    matchResult.guestEmail
  );
  
  if (emailExists) {
    console.log(`   🚫 Email job already exists for ${matchResult.guestEmail}`);
    
    // Update the record to show it's been processed
    await markAsProcessed(matchResult.eventId, matchResult.guestId);
    
    return {
      recordId: record.eventID,
      action: 'duplicate_prevented',
      reason: 'Email job already exists for this address'
    };
  }

  if (CONFIG.ENABLE_DEBUG_LOGGING) {
    console.log('   📋 Parsed match result:', JSON.stringify(matchResult, null, 2));
  }

  const validation = validateMatchResult(matchResult);
  if (!validation.isValid) {
    console.log(`   ⚠️  Invalid record: ${validation.reason}`);
    return {
      recordId: record.eventID,
      action: 'skipped',
      reason: validation.reason,
      eventId: matchResult.eventId,
      guestId: matchResult.guestId,
    };
  }

  const shouldSendEmail = evaluateEmailCriteria(matchResult);
  if (!shouldSendEmail.send) {
    console.log(`   ⏭️  Email not needed: ${shouldSendEmail.reason}`);
    return {
      recordId: record.eventID,
      action: 'skipped',
      reason: shouldSendEmail.reason,
      eventId: matchResult.eventId,
      guestId: matchResult.guestId,
    };
  }

  console.log(`   ✅ Email criteria met for guest ${matchResult.guestId}`);
  console.log(`      - Email: ${matchResult.guestEmail}`);
  console.log(`      - Total matches: ${matchResult.totalMatches}`);
  console.log(`      - Current delivery status: ${matchResult.deliveryStatus || 'none'}`);


  const updateResult = await updateDeliveryStatusToProcessing(
    matchResult.eventId,
    matchResult.guestId,
    matchResult.deliveryStatus
  );

  if (!updateResult.success) {
    console.log(`   🔄 Delivery status update failed: ${updateResult.reason}`);
    return {
      recordId: record.eventID,
      action: 'duplicate_prevented',
      reason: updateResult.reason,
      eventId: matchResult.eventId,
      guestId: matchResult.guestId,
    };
  }

  console.log('   🔄 Delivery status updated to "processing"');

  const emailJob = createEmailJob(matchResult);
  const sqsResult = await sendEmailJobToQueueWithDedup(emailJob);

  if (sqsResult.success) {
    console.log(`   📧 Email job queued successfully: ${sqsResult.messageId}`);
    return {
      recordId: record.eventID,
      action: 'email_triggered',
      eventId: matchResult.eventId,
      guestId: matchResult.guestId,
      messageId: sqsResult.messageId,
    };
  } else {
    console.error(`   ❌ Failed to queue email job: ${sqsResult.error}`);
    await revertDeliveryStatus(matchResult.eventId, matchResult.guestId);
    throw new Error(`Failed to queue email job: ${sqsResult.error}`);
  }
}


// New function to mark duplicate records as processed
async function markAsProcessed(eventId, guestId) {
  try {
    const command = new UpdateItemCommand({
      TableName: 'face_match_results',
      Key: {
        eventId: { S: eventId },
        guestId: { S: guestId },
      },
      UpdateExpression: 'SET delivery_status = :delivered, duplicate_detected_at = :timestamp',
      ExpressionAttributeValues: {
        ':delivered': { S: 'delivered' },
        ':timestamp': { S: new Date().toISOString() }
      }
    });
    
    await dynamoClient.send(command);
    console.log(`   ✅ Marked duplicate record ${guestId} as delivered`);
  } catch (error) {
    console.error(`   ⚠️ Failed to mark duplicate as processed: ${error.message}`);
  }
}


// Enhanced update function with email tracking
async function updateDeliveryStatusToProcessingWithEmailCheck(eventId, guestId, email, currentStatus) {
  try {
    // Store the email being processed to prevent duplicates
    let conditionExpression;
    let expressionAttributeValues = {
      ':processing': { S: 'processing' },
      ':timestamp': { S: new Date().toISOString() },
      ':email': { S: email.toLowerCase() }
    };

    if (!currentStatus || currentStatus === 'pending') {
      conditionExpression =
        'attribute_not_exists(delivery_status) OR delivery_status = :pending';
      expressionAttributeValues[':pending'] = { S: 'pending' };
    } else {
      conditionExpression = 'delivery_status = :currentStatus';
      expressionAttributeValues[':currentStatus'] = { S: currentStatus };
    }

    const updateCommand = new UpdateItemCommand({
      TableName: 'face_match_results',
      Key: {
        eventId: { S: eventId },
        guestId: { S: guestId },
      },
      UpdateExpression:
        'SET delivery_status = :processing, email_triggered_at = :timestamp, processing_email = :email',
      ConditionExpression: conditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    });

    const result = await dynamoClient.send(updateCommand);

    return { success: true, updatedItem: result.Attributes };
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      return {
        success: false,
        reason: 'Delivery status already changed (race condition prevented)',
        errorType: 'conditional_check_failed',
      };
    }
    console.error('Error updating delivery status:', error);
    return {
      success: false,
      reason: `Database error: ${error.message}`,
      errorType: 'database_error',
    };
  }
}

// Enhanced SQS function with deduplication
async function sendEmailJobToQueueWithDedup(emailJob) {
  try {
    const dedupId = `${emailJob.eventId}-${emailJob.guestInfo.email.toLowerCase()}`;
    
    const message = {
      id: `email_${emailJob.eventId}_${emailJob.guestId}_${Date.now()}`,
      type: 'photo_match_notification',
      payload: emailJob,
      metadata: {
        queuedAt: new Date().toISOString(),
        version: '1.0',
        dedupId: dedupId
      },
    };

    const command = new SendMessageCommand({
      QueueUrl: CONFIG.EMAIL_QUEUE_URL,
      MessageBody: JSON.stringify(message),
      MessageAttributes: {
        messageType: { DataType: 'String', StringValue: 'photo_match_notification' },
        eventId: { DataType: 'String', StringValue: emailJob.eventId },
        guestId: { DataType: 'String', StringValue: emailJob.guestId },
        guestEmail: { DataType: 'String', StringValue: emailJob.guestInfo.email.toLowerCase() },
        priority: { DataType: 'String', StringValue: emailJob.jobMetadata.priority },
        totalMatches: {
          DataType: 'Number',
          StringValue: emailJob.matchInfo.totalMatches.toString(),
        },
      },
      DelaySeconds: emailJob.jobMetadata.priority === 'high' ? 0 : 5,
      // If using FIFO queue, add these:
      // MessageDeduplicationId: dedupId,
      // MessageGroupId: emailJob.eventId
    });

    const result = await sqsClient.send(command);
    
    console.log(`   ✅ SQS message sent with dedupId: ${dedupId}`);

    return { success: true, messageId: result.MessageId, message: 'Email job queued successfully' };
  } catch (error) {
    console.error('Error sending message to SQS:', error);
    return { success: false, error: error.message, errorType: error.name };
  }
}

// ===================================
// Data Parsing and Validation
// ===================================

function parseDynamoDBRecord(newImage) {
  try {
    return {
      eventId: newImage.eventId?.S,
      guestId: newImage.guestId?.S,
      guestName: newImage.guest_name?.S,
      guestEmail: newImage.guest_email?.S,
      guestPhone: newImage.guest_phone?.S,
      
      // ADD THESE FIELDS
      email_status: newImage.email_status?.S,
      email_sent: newImage.email_sent?.BOOL,
      whatsapp_status: newImage.whatsapp_status?.S,
      whatsapp_sent: newImage.whatsapp_sent?.BOOL,
      
      guestSelfieUrl: newImage.guest_selfie_url?.S,
      guestRegistrationId: newImage.guest_registration_id?.S,
      totalMatches: parseInt(newImage.total_matches?.N || '0'),
      newMatches: parseInt(newImage.new_matches?.N || '0'),
      bestSimilarity: parseFloat(newImage.best_similarity?.N || '0'),
      averageSimilarity: parseFloat(newImage.average_similarity?.N || '0'),
      profileQuality: parseFloat(newImage.profile_quality?.N || '0'),
      overallScore: parseFloat(newImage.overall_score?.N || '0'),
      deliveryStatus: newImage.delivery_status?.S,
      processedAt: newImage.processed_at?.S,
      createdAt: newImage.created_at?.S,
      algorithmVersion: newImage.algorithm_version?.S,
      updateMode: newImage.update_mode?.S,
      matchedImages: newImage.matched_images?.S ? JSON.parse(newImage.matched_images.S) : [],
      matchStatistics: newImage.match_statistics?.S ? JSON.parse(newImage.match_statistics.S) : {},
    };
  } catch (error) {
    console.error('Error parsing DynamoDB record:', error);
    throw new Error(`Failed to parse DynamoDB record: ${error.message}`);
  }
}

function validateMatchResult(matchResult) {
  if (!matchResult.eventId) return { isValid: false, reason: 'Missing eventId' };
  if (!matchResult.guestId) return { isValid: false, reason: 'Missing guestId' };
  if (!matchResult.guestEmail || !isValidEmail(matchResult.guestEmail)) {
    return { isValid: false, reason: 'Missing or invalid guest email' };
  }
  if (!matchResult.guestName) return { isValid: false, reason: 'Missing guest name' };
  if (typeof matchResult.totalMatches !== 'number') {
    return { isValid: false, reason: 'Invalid totalMatches field' };
  }
  return { isValid: true };
}

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// ===================================
// Business Logic
// ===================================
function evaluateEmailCriteria(matchResult) {
  // CRITICAL: Check email_status FIRST
  if (matchResult.email_status === 'sent' || matchResult.email_sent === true) {
    return { 
      send: false, 
      reason: 'Email already sent (email_status check)' 
    };
  }

  if (matchResult.totalMatches < CONFIG.MIN_MATCHES_FOR_EMAIL) {
    return {
      send: false,
      reason: `Insufficient matches: ${matchResult.totalMatches} < ${CONFIG.MIN_MATCHES_FOR_EMAIL}`,
    };
  }

  const status = matchResult.deliveryStatus;
  if (status === 'delivered') {
    return { send: false, reason: 'Email already delivered (delivery_status)' };
  }
  if (status === 'processing') {
    return { send: false, reason: 'Email delivery already in progress' };
  }

  if (
    matchResult.guestEmail.includes('example.com') ||
    matchResult.guestEmail.includes('test.com') ||
    matchResult.guestEmail.startsWith('unknown@')
  ) {
    return { send: false, reason: 'Test or invalid email address' };
  }

  return { send: true, reason: 'All criteria met' };
}

// ===================================
// DynamoDB Operations
// ===================================

async function updateDeliveryStatusToProcessing(eventId, guestId, currentStatus) {
  try {
    // Conditional update: only if status is pending or not set, or matches what we saw
    let conditionExpression;
    let expressionAttributeValues = {
      ':processing': { S: 'processing' },
      ':timestamp': { S: new Date().toISOString() },
    };

    if (!currentStatus || currentStatus === 'pending') {
      conditionExpression =
        'attribute_not_exists(delivery_status) OR delivery_status = :pending';
      expressionAttributeValues[':pending'] = { S: 'pending' };
    } else {
      conditionExpression = 'delivery_status = :currentStatus';
      expressionAttributeValues[':currentStatus'] = { S: currentStatus };
    }

    const updateCommand = new UpdateItemCommand({
      TableName: 'face_match_results',
      Key: {
        eventId: { S: eventId },
        guestId: { S: guestId },
      },
      UpdateExpression:
        'SET delivery_status = :processing, email_triggered_at = :timestamp',
      ConditionExpression: conditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    });

    const result = await dynamoClient.send(updateCommand);

    return { success: true, updatedItem: result.Attributes };
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      return {
        success: false,
        reason: 'Delivery status already changed (race condition prevented)',
        errorType: 'conditional_check_failed',
      };
    }
    console.error('Error updating delivery status:', error);
    return {
      success: false,
      reason: `Database error: ${error.message}`,
      errorType: 'database_error',
    };
  }
}

async function revertDeliveryStatus(eventId, guestId) {
  try {
    console.log(`🔄 Reverting delivery status for ${guestId} due to queue failure`);

    const updateCommand = new UpdateItemCommand({
      TableName: 'face_match_results',
      Key: {
        eventId: { S: eventId },
        guestId: { S: guestId },
      },
      UpdateExpression:
        'SET delivery_status = :pending, email_error_at = :timestamp',
      ExpressionAttributeValues: {
        ':pending': { S: 'pending' },
        ':timestamp': { S: new Date().toISOString() },
      },
    });

    await dynamoClient.send(updateCommand);
    console.log('✅ Delivery status reverted to pending');
  } catch (error) {
    console.error('❌ Failed to revert delivery status:', error);
  }
}

// Right before calling createEmailJob, add one final check:
if (matchResult.email_status === 'sent' || matchResult.email_sent === true) {
  console.log('   🛑 FINAL CHECK: Email already sent, aborting SQS message creation');
  return {
    recordId: record.eventID,
    action: 'skipped',
    reason: 'Email already sent - final check before SQS'
  };
}

const emailJob = createEmailJob(matchResult);

// ===================================
// SQS Operations
// ===================================

function createEmailJob(matchResult) {
  const topMatches = matchResult.matchedImages.slice(0, 10).map((match) => ({
    imageUrl: match.pool_url,
    filename: match.pool_filename,
    similarity: match.similarity_score,
    confidence: match.match_confidence,
  }));

  return {
    eventId: matchResult.eventId,
    guestId: matchResult.guestId,
    guestInfo: {
      name: matchResult.guestName,
      email: matchResult.guestEmail,
      phone: matchResult.guestPhone,
      registrationId: matchResult.guestRegistrationId,
      selfieUrl: matchResult.guestSelfieUrl,
    },
    matchInfo: {
      totalMatches: matchResult.totalMatches,
      newMatches: matchResult.newMatches,
      bestSimilarity: matchResult.bestSimilarity,
      averageSimilarity: matchResult.averageSimilarity,
      profileQuality: matchResult.profileQuality,
      topMatches,
    },
    emailMetadata: {
      galleryUrl: `https://hapzea.com/gallery/${matchResult.eventId}/${matchResult.guestId}`,
      eventName: `Event ${matchResult.eventId}`,
      processedAt: matchResult.processedAt,
      algorithmVersion: matchResult.algorithmVersion,
      triggerSource: 'face_search_results',
    },
    jobMetadata: {
      createdAt: new Date().toISOString(),
      priority: matchResult.totalMatches >= 10 ? 'high' : 'normal',
      retryCount: 0,
      maxRetries: CONFIG.MAX_RETRIES,
    },
  };
}

async function sendEmailJobToQueue(emailJob) {
  try {
    const message = {
      id: `email_${emailJob.eventId}_${emailJob.guestId}_${Date.now()}`,
      type: 'photo_match_notification',
      payload: emailJob,
      metadata: {
        queuedAt: new Date().toISOString(),
        version: '1.0',
      },
    };

    const command = new SendMessageCommand({
      QueueUrl: CONFIG.EMAIL_QUEUE_URL,
      MessageBody: JSON.stringify(message),
      MessageAttributes: {
        messageType: { DataType: 'String', StringValue: 'photo_match_notification' },
        eventId: { DataType: 'String', StringValue: emailJob.eventId },
        guestId: { DataType: 'String', StringValue: emailJob.guestId },
        priority: { DataType: 'String', StringValue: emailJob.jobMetadata.priority },
        totalMatches: {
          DataType: 'Number',
          StringValue: emailJob.matchInfo.totalMatches.toString(),
        },
      },
      DelaySeconds: emailJob.jobMetadata.priority === 'high' ? 0 : 5,
    });

    const result = await sqsClient.send(command);

    return { success: true, messageId: result.MessageId, message: 'Email job queued successfully' };
  } catch (error) {
    console.error('Error sending message to SQS:', error);
    return { success: false, error: error.message, errorType: error.name };
  }
}

// ===================================
// Metrics and Monitoring
// ===================================

async function publishMetrics(metrics) {
  try {
    const metricData = [
      {
        MetricName: 'StreamRecordsProcessed',
        Value: metrics.processedRecords,
        Unit: 'Count',
        Dimensions: [{ Name: 'FunctionName', Value: 'process-match-results-stream' }],
      },
      {
        MetricName: 'EmailsTriggered',
        Value: metrics.emailsTriggered,
        Unit: 'Count',
        Dimensions: [{ Name: 'FunctionName', Value: 'process-match-results-stream' }],
      },
      {
        MetricName: 'DuplicatesPrevented',
        Value: metrics.duplicatesPrevented,
        Unit: 'Count',
        Dimensions: [{ Name: 'FunctionName', Value: 'process-match-results-stream' }],
      },
      {
        MetricName: 'ProcessingErrors',
        Value: metrics.errorRecords,
        Unit: 'Count',
        Dimensions: [{ Name: 'FunctionName', Value: 'process-match-results-stream' }],
      },
    ];

    const command = new PutMetricDataCommand({
      Namespace: 'FaceSearch/EmailNotifications',
      MetricData: metricData,
    });

    await cloudwatchClient.send(command);
    console.log('📊 Metrics published to CloudWatch');
  } catch (error) {
    console.error('❌ Failed to publish metrics:', error);
  }
}

// ===================================
// Configuration Validation
// ===================================

if (!CONFIG.EMAIL_QUEUE_URL) {
  console.error('❌ Missing required environment variable: EMAIL_QUEUE_URL');
  throw new Error('EMAIL_QUEUE_URL environment variable is required');
}

console.log('🔧 Stream Processor Configuration:');
console.log(`  AWS Region: ${CONFIG.AWS_REGION}`);
console.log(`  Email Queue URL: ${CONFIG.EMAIL_QUEUE_URL ? 'Configured' : 'Missing'}`);
console.log(`  Min Matches for Email: ${CONFIG.MIN_MATCHES_FOR_EMAIL}`);
console.log(`  Metrics Enabled: ${CONFIG.ENABLE_METRICS}`);
console.log(`  Debug Logging: ${CONFIG.ENABLE_DEBUG_LOGGING}`);
console.log(`  Max Retries: ${CONFIG.MAX_RETRIES}`);
