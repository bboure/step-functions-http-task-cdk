import { Duration, SecretValue, StackProps, Stack } from 'aws-cdk-lib';
import { Authorization, Connection } from 'aws-cdk-lib/aws-events';
import { Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import {
  Chain,
  CustomState,
  DefinitionBody,
  Parallel,
  StateMachine,
} from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';

export class SfHttpStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const keygenConnection = new Connection(this, 'KeygenConnection', {
      authorization: Authorization.apiKey(
        'Authorization',
        SecretValue.secretsManager('KeygenSecret'),
      ),
    });

    const keygenEndpoint =
      'https://api.keygen.sh/v1/accounts/07fab0ef-505c-447d-ae6a-932b5339300d';

    const createLicense = new CustomState(this, 'CreateLicense', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::http:invoke',
        Parameters: {
          ApiEndpoint: `${keygenEndpoint}/licenses`,
          Method: 'POST',
          Authentication: {
            ConnectionArn: keygenConnection.connectionArn,
          },
          RequestBody: {
            data: {
              type: 'licenses',
              attributes: {
                metadata: {
                  'transactionId.$': '$.data.id',
                  'customerId.$': '$.data.customer_id',
                },
              },
              relationships: {
                policy: {
                  data: {
                    type: 'policies',
                    id: '8c2294b0-dbbe-4028-b561-6aa246d60951',
                  },
                },
              },
            },
          },
        },
        ResultSelector: {
          'body.$': 'States.StringToJson($.ResponseBody)',
        },
        OutputPath: '$.body',
      },
    });

    const paddleConnection = new Connection(this, 'PaddleConnection', {
      authorization: Authorization.apiKey(
        'Authorization',
        SecretValue.secretsManager('PaddleSecret'),
      ),
    });

    const paddleEndpoint = 'https://sandbox-api.paddle.com';

    const getCustomer = new CustomState(this, 'GetCustomer', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::http:invoke',
        Parameters: {
          'ApiEndpoint.$': `States.Format('${paddleEndpoint}/customers/{}', $.data.customer_id)`,
          Method: 'GET',
          Authentication: {
            ConnectionArn: paddleConnection.connectionArn,
          },
        },
        OutputPath: '$.ResponseBody',
      },
    });

    createLicense.addRetry({
      errors: ['States.ALL'],
      interval: Duration.seconds(1),
      maxAttempts: 3,
    });

    const parallel = new Parallel(this, 'Parallel', {
      resultSelector: {
        'license.$': '$[0]',
        'customer.$': '$[1]',
      },
    });

    parallel.branch(createLicense).branch(getCustomer);

    const sendEmail = new CustomState(this, 'SendEmail', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::aws-sdk:sesv2:sendEmail',
        Parameters: {
          Content: {
            Simple: {
              Body: {
                Text: {
                  Charset: 'UTF-8',
                  'Data.$':
                    "States.Format('Hi {}, \n\nYour license key is: {}', $.customer.data.name, $.license.data.attributes.key)",
                },
              },
              Subject: {
                Charset: 'UTF-8',
                Data: 'Your license key',
              },
            },
          },
          Destination: {
            'ToAddresses.$': 'States.Array($.customer.data.email)',
          },
          FromEmailAddress: 'benoit@serverless.rehab',
        },
        End: true,
      },
    });

    const chain = Chain.start(parallel).next(sendEmail);

    const sm = new StateMachine(this, 'PurchaseHandler', {
      definitionBody: DefinitionBody.fromChainable(chain),
    });

    // https://docs.aws.amazon.com/step-functions/latest/dg/connect-third-party-apis.html#connect-http-task-permissions
    sm.role.attachInlinePolicy(
      new Policy(this, 'HttpInvoke', {
        statements: [
          new PolicyStatement({
            actions: ['states:InvokeHTTPEndpoint'],
            resources: [sm.stateMachineArn],
            conditions: {
              StringEquals: {
                'states:HTTPMethod': 'POST',
              },
              StringLike: {
                'states:HTTPEndpoint': `${keygenEndpoint}/*`,
              },
            },
          }),
          new PolicyStatement({
            actions: ['states:InvokeHTTPEndpoint'],
            resources: [sm.stateMachineArn],
            conditions: {
              StringEquals: {
                'states:HTTPMethod': 'GET',
              },
              StringLike: {
                'states:HTTPEndpoint': `${paddleEndpoint}/*`,
              },
            },
          }),
          new PolicyStatement({
            actions: ['events:RetrieveConnectionCredentials'],
            resources: [
              keygenConnection.connectionArn,
              paddleConnection.connectionArn,
            ],
          }),
          new PolicyStatement({
            actions: [
              'secretsmanager:GetSecretValue',
              'secretsmanager:DescribeSecret',
            ],
            resources: [
              'arn:aws:secretsmanager:*:*:secret:events!connection/*',
            ],
          }),
          // allow sending emails with ses
          new PolicyStatement({
            actions: ['ses:SendEmail', 'ses:SendRawEmail'],
            resources: ['*'],
          }),
        ],
      }),
    );
  }
}
