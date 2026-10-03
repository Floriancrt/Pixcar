# Pixcar — instructions pour les agents

Les règles ci-dessous viennent de l'AWS Agent Toolkit (expérience « nouvelle expérience AWS »). Les consignes propres au projet priment en cas de conflit.

<!-- BEGIN AWS Agent Toolkit rules -->
# AWS Guidance for the new AWS experience

This user has signed up for the new AWS experience. This experience lets you sign into AWS using a social provider and requires the following additional context.

Where this guidance conflicts with the project's own instructions, the project's instructions take precedence.

## Context

### Terminology:

- Say "project" instead of "account" — a project contains an AWS account and settings for sharing with other collaborators
- Say "team member" instead of "IAM user" — users are invited by email, not created or federated in IAM
- Say "AWS Settings" when referring to management tasks at [settings.aws.com](https://settings.aws.com/) (project management, billing, team members, spend limits). Users view their actual AWS resources in the AWS Management Console.
- Say "selected Region" when referring to the user's Region — not "home Region"
- The user has a managed IAM experience. This includes a managed service control policies (SCP) and resource control policies (RCP) that govern the use of AWS. They will still need to use IAM to create policies to let services work with each other. If there are questions about the SCPs or RCPs, go to the documentation at https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html

### Constraints:

- All projects share a single AWS Region determined by the user's contact address. Resources cannot be created in other Regions
- When developing:
  - MUST create all Regional resources in the project's assigned Region
  - You CAN create AWS WAF and Cloudwatch Logs resources in us-east-1 when there are global resources (like a global WAF instance) that require a connection to dependencies in us-east-1. You should not use these for any other reason, because resources in the selected Region will provide lower cost (due to no cross-Region traffic), increased availability (due to no cross-Region traffic), and easier manageability (due to not needing to look in another Region). When you need to do an inventory of resources, you need to look in both the selected Region and us-east-1 for Cloudwatch Logs or WAF resources.
  - MUST NOT attempt to create Lambda, API Gateway, or other Regional resources in any other Region
  - MUST direct users to confirm their Region in AWS Settings > View all projects > Overview > Additional Info > Region. If the user cannot confirm their Region, check in ~/.aws/config
  - MUST NOT use Lambda@Edge — excluded from both Lambda and CloudFront
  - MUST NOT use CloudFormation StackSets — no multi-account or multi-Region deployments
  - MUST NOT attempt cross-Region actions — no cross-Region replication for DynamoDB/S3/RDS, no multi-Region KMS keys
  - MUST NOT use Route 53 cross-Region routing — geolocation, latency-based, and failover routing policies are not available
  - CloudFront is a global service and its actions ARE allowed in `us-east-1`. A user can create a CloudFront distribution pointing to their project-region Lambda function URL or API Gateway. However, Lambda and API Gateway themselves MUST NOT be created in `us-east-1` — they must be in the project Region.
  - Reduced availability in `eu-north-1` specifically: Amazon Rekognition, Amazon Textract, Amazon Personalize, AWS App Runner are not available in that Region.
- IAM permissions for human access are managed by AWS. Don't assign roles to team members unless absolutely necessary
- The user may have a spend limit if they are on the paid plan. The limit that pauses their project if it's exceeded. If resources suddenly become inaccessible, ask if they have a spend limit configured. Only project owners can modify a spend limit.
- When developing:
  - MUST ask about spend limit status if the user reports sudden "Access Denied" errors on operations that previously worked
  - MUST direct users to check spend status in AWS Settings > Billing
  - MUST check if a user has upgraded their account to the paid plan
  - MUST ask the user if they want to clean up the successfully created resources or keep them to reduce cost
- The user sets up billing, creates spend limits, and retrieves and pays invoices in AWS Settings. The user creates budgets and optimizes their costs in the AWS Billing and Cost Management console
- Not all AWS services are available. If a service isn't working, do the following:
  1. Run the command `aws freetier get-account-plan-state`
  2. If accountPlanType": "FREE", check the [Free Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-free-tier) next,
  3. If accountPlanType": "PAID", check the [Paid Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-paid-plan).
  4. If neither list shows the service, check the [Not supported for this experience list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#unsupported-services). The user will need to activate advanced features to access this service.
- Users can activate advanced AWS services and capabilities for their account.
- Before starting a task, check whether a relevant AWS skill is available. Load the skill with retrieve_skill and prefer its guidance over general knowledge.

### Help level

- help_level (required): LOW, MEDIUM, or HIGH. While a user is building, you MUST ask the user: "How much guidance would you like from me? Low (I only flag security risks), medium (I ask a couple of clarifying questions if something seems off), or high (I explain what I'm doing, suggest alternatives, and flag best practices)."

You CAN update this rule file to save a user's help_level.

Constraints for each level:

**LOW:**

- MUST follow all constraints in this context file
- MUST execute the user’s request without modification
- MUST NOT ask clarifying questions unless the action would create a security vulnerability
- MUST NOT suggest alternatives or improvements

**MEDIUM:**

- MUST execute the user's request
- MAY ask up to two clarifying questions per task if the request has an ambiguity or a potential issue
- MUST NOT repeat a question or suggestion the user has already dismissed
- MUST NOT explain trade-offs or alternatives unless the user asks

**HIGH:**

- MUST explain what each step does and why before executing it
- MUST suggest alternatives when a better approach exists
- MUST flag best practices and explain trade-offs
- MUST still execute the user's choice if they disagree with a suggestion
<!-- END AWS Agent Toolkit rules -->

## Préférences AWS de l'utilisateur

Enregistrées hors des balises ci-dessus pour survivre à une mise à jour des règles de l'AWS Agent Toolkit.

- help_level: HIGH — expliquer chaque étape et son intérêt avant de l'exécuter, proposer des alternatives quand il y en a de meilleures, signaler les bonnes pratiques et expliquer les compromis ; exécuter quand même le choix de l'utilisateur s'il n'est pas d'accord avec une suggestion.
- Créer une ressource AWS (même gratuite : bucket, paramètre, pile, certificat) seulement après un accord explicite de l'utilisateur pour cette étape ; lecture seule (tarifs, documentation, listes) sans demander. Ne jamais afficher la valeur d'un secret (`PLATE_PEPPER`, `IP_PEPPER`) : la générer et l'enregistrer sans l'imprimer.
- Architecture choisie par l'utilisateur : API Gateway (HTTP API) + Lambda (arm64, Node 22) + Aurora DSQL, région `eu-north-1`, pile `infra/pixcar-api.yaml` (voir `docs/exploitation.md`, section 3 bis).
- Plan gratuit AWS : 100 USD de crédits, **fin du plan le 3 avril 2027 à 16 h 46 UTC** ou à l'épuisement des crédits (relevé par `aws freetier get-account-plan-state` le 3 octobre 2026). Ensuite suspension, avec 90 jours pour passer au plan payant avant suppression (**à revérifier dans AWS Settings → Billing**). À rappeler avant cette date et avant toute ressource payante.
- Déploiement réalisé le 3 octobre 2026 : pile `pixcar` (`eu-north-1`), API en ligne (adresse dans les sorties de la pile), `selfcheck` 18/18 sur Aurora DSQL et essai de bout en bout réussis. Bucket du code et clé de l'archive courante : paramètres de la pile (`describe-stacks`). Mise à jour : construire, déposer, `update-stack` avec le nouveau `CodeKey` (`docs/exploitation.md`). Demande d'augmentation du quota Lambda (10 → 1 000) soumise le 3 octobre 2026 (cas 179106060800000) : toujours en attente d'AWS (`CASE_OPENED`, quota à 10) le jour même. **Reste à faire, chaque étape après accord** : sauvegardes (AWS Backup), politique de confidentialité, republication du site avec `PIXCAR_API_BASE`, CloudTrail si un journal d'audit est voulu.
- Domaine de l'API : `api.pixcar.fr` est en service depuis le 3 octobre 2026 (certificat ACM émis, validation DNS et CNAME `api` créés chez IONOS, pile mise à jour avec `ApiDomainName` et `ApiCertificateArn`). **Vérifié par l'utilisateur dans son navigateur** : `https://api.pixcar.fr/readyz` renvoie `{"ok":true,"db":"up"}` (DNS, certificat, correspondance d'API Gateway, Lambda et Aurora DSQL de bout en bout). **Non rejoué** : `scripts/smoke-api.mjs` sur ce domaine (le relais réseau du bac à sable refuse `api.pixcar.fr` ; le scénario complet n'a tourné que sur l'adresse `execute-api`, qui est la même API). **Ne pas republier le site en mode API sans accord explicite** : c'est l'ouverture au public (à prévoir avant : sauvegardes AWS Backup, politique de confidentialité, réponse d'AWS sur le quota Lambda).
